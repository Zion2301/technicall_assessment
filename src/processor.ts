import { randomUUID } from 'node:crypto';
import type { AppContext } from './context';
import type { Currency } from './money';
import { type AttemptOutcome, applyAttemptOutcome } from './outcomes';
import type { Recipient, SendResult } from './providers/types';
import type { PayoutStatus } from './stateMachine';
import { transitionPayout } from './transitions';

/** A payout this worker has exclusively claimed, with its attempt recorded. */
export interface Claim {
  payoutId: string;
  attemptId: string;
  attemptNumber: number;
  reference: string;
  provider: string;
  amountMinor: number;
  currency: Currency;
  recipient: Recipient;
}

/**
 * Moves payouts forward. Designed to be run on a timer by one or more
 * workers. Every step is safe to repeat and safe to run concurrently,
 * because ownership is decided by compare-and-swap in the database.
 *
 * The database is the queue: "due" work is simply rows in the right status.
 * There's no separate broker that can disagree with the DB about what's pending.
 */
export class PayoutProcessor {
  constructor(private readonly ctx: AppContext) {}

  /** One full cycle of work. */
  async tick(): Promise<void> {
    await this.processDuePayouts();
  }

  /** Sends every payout that's pending, or whose retry is due. */
  async processDuePayouts(): Promise<number> {
    const due = this.ctx.db
      .prepare(
        `SELECT id FROM payouts
          WHERE status = 'pending' OR (status = 'awaiting_retry' AND next_attempt_at <= ?)
          ORDER BY created_at, id LIMIT ?`,
      )
      .pluck()
      .all(this.ctx.clock.now(), this.ctx.config.batchSize) as string[];

    let sent = 0;
    for (const payoutId of due) {
      const claim = this.claim(payoutId);
      if (!claim) continue; // another worker got there first
      await this.send(claim);
      sent++;
    }
    return sent;
  }

  /**
   * Step 1 of sending: claim the payout AND record the attempt, in one
   * transaction, and commit BEFORE calling the provider.
   *
   * That committed attempt row is our "intent log". If we crash after this
   * point, the reconciler will find an open attempt and ask the provider
   * about its reference, instead of the payout being lost or sent twice.
   */
  claim(payoutId: string): Claim | null {
    const { db, clock } = this.ctx;
    const now = clock.now();

    return db.transaction((): Claim | null => {
      const p = db
        .prepare(`SELECT id, status, next_attempt_at, provider, amount_minor, currency, recipient_json FROM payouts WHERE id = ?`)
        .get(payoutId) as
        | { id: string; status: PayoutStatus; next_attempt_at: number | null; provider: string; amount_minor: number; currency: Currency; recipient_json: string }
        | undefined;
      if (!p) return null;
      const isDue = p.status === 'pending' || (p.status === 'awaiting_retry' && (p.next_attempt_at ?? 0) <= now);
      if (!isDue) return null;

      const attemptNumber = (db.prepare(`SELECT COUNT(*) FROM payout_attempts WHERE payout_id = ?`).pluck().get(p.id) as number) + 1;
      // Deterministic: the same payout + attempt number always maps to the same
      // provider reference, which is our idempotency key towards the provider.
      const reference = `${p.id}_a${attemptNumber}`;

      const won = transitionPayout(db, {
        payoutId: p.id, from: p.status, to: 'processing', actor: 'processor', at: now,
        reason: `Attempt ${attemptNumber} started`, metadata: { reference, provider: p.provider },
      });
      if (!won) return null;

      const attemptId = `att_${randomUUID()}`;
      db.prepare(
        `INSERT INTO payout_attempts (id, payout_id, attempt_number, provider, provider_reference, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'in_flight', ?, ?)`,
      ).run(attemptId, p.id, attemptNumber, p.provider, reference, now, now);

      return {
        payoutId: p.id, attemptId, attemptNumber, reference, provider: p.provider,
        amountMinor: p.amount_minor, currency: p.currency, recipient: JSON.parse(p.recipient_json) as Recipient,
      };
    })();
  }

  /** Step 2 of sending: call the provider (outside any transaction) and record what we learned. */
  async send(claim: Claim): Promise<void> {
    const provider = this.ctx.providers.byName(claim.provider);
    let result: SendResult;
    try {
      result = await provider.sendPayout({
        reference: claim.reference,
        amountMinor: claim.amountMinor,
        currency: claim.currency,
        recipient: claim.recipient,
      });
    } catch (err) {
      // ANY exception here means "we don't know whether money moved". The one
      // thing we must not do is retry with a new reference. Mark it unknown and
      // let the reconciler find out.
      applyAttemptOutcome(this.ctx, claim.attemptId, { kind: 'unknown', reason: describeError(err) }, 'processor');
      return;
    }
    applyAttemptOutcome(this.ctx, claim.attemptId, fromSendResult(result), 'processor', { response: result });
  }
}

export function fromSendResult(result: SendResult): AttemptOutcome {
  switch (result.outcome) {
    case 'succeeded':
      return { kind: 'succeeded' };
    case 'accepted':
      return { kind: 'accepted' };
    case 'failed':
      return { kind: 'failed', code: result.code, retryable: result.retryable };
  }
}

export function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
