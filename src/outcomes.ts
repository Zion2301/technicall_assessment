import type { AppContext } from './context';
import { ACCOUNTS, postMove } from './ledger';
import { formatMoney, money, type Currency } from './money';
import { backoffDelay } from './retry';
import { type AttemptStatus, canTransition, isAttemptOpen, type PayoutStatus } from './stateMachine';
import { type Actor, recordPayoutNote, transitionPayout } from './transitions';

/**
 * What we learned about one attempt, from any source: the send response,
 * a status check, or a webhook.
 */
export type AttemptOutcome =
  | { kind: 'accepted' } // provider has it, final result pending
  | { kind: 'unknown'; reason: string } // we can't tell if it reached the provider
  | { kind: 'succeeded' }
  | { kind: 'failed'; code: string; retryable: boolean };

/**
 * applied:   we learned something new and acted on it
 * duplicate: we already knew this (e.g. webhook after the send response said the same)
 * stale:     older/weaker news than what we already know (e.g. "pending" after "succeeded")
 * conflict:  contradicts what we know; escalated for a human
 */
export type ApplyResult = 'applied' | 'duplicate' | 'stale' | 'conflict';

interface AttemptRow {
  id: string;
  payout_id: string;
  attempt_number: number;
  provider_reference: string;
  status: AttemptStatus;
}

interface PayoutRow {
  id: string;
  status: PayoutStatus;
  amount_minor: number;
  currency: Currency;
  employee_id: string;
  last_error: string | null;
}

const OPEN = `('in_flight', 'accepted', 'unknown')`;

/**
 * Marks a payout escalated because of contradictory provider evidence. Unlike
 * an ordinary "we couldn't find out" escalation, a conflict may mean money
 * moved twice, so it is never auto-resolved by later signals: only an operator
 * can close it.
 */
const CONFLICT_MARKER = 'conflict';

/**
 * The single place where provider results turn into state changes. The send
 * path, the reconciler and webhooks all call this, so they can never disagree
 * about what a given result means.
 *
 * Runs in one transaction: attempt update + payout transition + ledger entry
 * either all happen or none do.
 */
export function applyAttemptOutcome(
  ctx: AppContext,
  attemptId: string,
  outcome: AttemptOutcome,
  actor: Actor,
  evidence: Record<string, unknown> = {},
): ApplyResult {
  const { db } = ctx;
  const now = ctx.clock.now();

  return db.transaction((): ApplyResult => {
    const attempt = db
      .prepare(`SELECT id, payout_id, attempt_number, provider_reference, status FROM payout_attempts WHERE id = ?`)
      .get(attemptId) as AttemptRow;
    const payout = db
      .prepare(`SELECT id, status, amount_minor, currency, employee_id, last_error FROM payouts WHERE id = ?`)
      .get(attempt.payout_id) as PayoutRow;
    const meta = { reference: attempt.provider_reference, attempt: attempt.attempt_number, ...evidence };

    if (!isAttemptOpen(attempt.status)) return handleClosedAttempt(ctx, attempt, payout, outcome, actor, meta);

    const isFinalNews = outcome.kind === 'succeeded' || outcome.kind === 'failed';
    if (isFinalNews && payout.status === 'needs_review' && payout.last_error === CONFLICT_MARKER) {
      // Record the evidence on the attempt, but leave the decision to a human.
      closeAttempt(ctx, attempt.id, outcome.kind, now, outcome.kind === 'failed' ? outcome.code : undefined);
      recordPayoutNote(db, {
        payoutId: payout.id, status: payout.status, actor, at: now, metadata: meta,
        reason: `Attempt ${attempt.attempt_number} reported ${outcome.kind}; payout is under conflict review, not auto-resolving`,
      });
      return 'conflict';
    }

    switch (outcome.kind) {
      case 'accepted':
        if (attempt.status === 'accepted') return 'duplicate';
        updateAttempt(ctx, attempt.id, 'accepted', now);
        return 'applied';

      case 'unknown':
        // Only an attempt we know nothing about becomes "unknown". If the provider
        // already acknowledged it (accepted), a later timeout doesn't erase that.
        if (attempt.status !== 'in_flight') return 'stale';
        updateAttempt(ctx, attempt.id, 'unknown', now, { raw: outcome.reason });
        recordPayoutNote(db, {
          payoutId: payout.id, status: payout.status, actor, at: now, metadata: meta,
          reason: `Outcome unknown (${outcome.reason}); will check status with the provider, NOT resend blindly`,
        });
        return 'applied';

      case 'succeeded': {
        closeAttempt(ctx, attempt.id, 'succeeded', now);
        return settleSucceeded(ctx, payout, actor, meta, now);
      }

      case 'failed': {
        closeAttempt(ctx, attempt.id, 'failed', now, outcome.code, outcome.retryable);
        return settleFailed(ctx, payout, attempt, outcome, actor, meta, now);
      }
    }
  })();
}

function settleSucceeded(ctx: AppContext, payout: PayoutRow, actor: Actor, meta: Record<string, unknown>, now: number): ApplyResult {
  if (!canTransition(payout.status, 'succeeded')) return escalateConflict(ctx, payout, actor, meta, now, `Success reported while payout was ${payout.status}`);

  const moved = transitionPayout(ctx.db, {
    payoutId: payout.id, from: payout.status, to: 'succeeded', actor, at: now, metadata: meta,
    reason: `Provider confirmed payment of ${formatMoney(money(payout.amount_minor, payout.currency))}`,
  });
  if (!moved) return 'duplicate';

  postMove(ctx.db, {
    kind: 'settle', payoutId: payout.id, from: ACCOUNTS.inFlight, to: ACCOUNTS.paidToEmployees,
    amountMinor: payout.amount_minor, currency: payout.currency, at: now,
    description: `Paid ${payout.employee_id}`,
  });
  return 'applied';
}

function settleFailed(
  ctx: AppContext,
  payout: PayoutRow,
  attempt: AttemptRow,
  failure: Extract<AttemptOutcome, { kind: 'failed' }>,
  actor: Actor,
  meta: Record<string, unknown>,
  now: number,
): ApplyResult {
  const { retry } = ctx.config;
  const canRetry = failure.retryable && attempt.attempt_number < retry.maxAttempts;
  const target: PayoutStatus = canRetry ? 'awaiting_retry' : 'failed';
  if (!canTransition(payout.status, target)) return escalateConflict(ctx, payout, actor, meta, now, `Failure reported while payout was ${payout.status}`);

  if (canRetry) {
    const delay = backoffDelay(attempt.attempt_number, retry, ctx.random);
    const moved = transitionPayout(ctx.db, {
      payoutId: payout.id, from: payout.status, to: 'awaiting_retry', actor, at: now,
      nextAttemptAt: now + delay, lastError: failure.code, metadata: { ...meta, code: failure.code, retryInMs: delay },
      reason: `Attempt ${attempt.attempt_number} failed (${failure.code}, retryable); retry ${attempt.attempt_number + 1}/${retry.maxAttempts} in ${Math.round(delay / 1000)}s`,
    });
    return moved ? 'applied' : 'duplicate';
  }

  const why = failure.retryable ? `retries exhausted after ${attempt.attempt_number} attempts` : 'not retryable';
  const moved = transitionPayout(ctx.db, {
    payoutId: payout.id, from: payout.status, to: 'failed', actor, at: now, lastError: failure.code,
    metadata: { ...meta, code: failure.code }, reason: `Attempt ${attempt.attempt_number} failed (${failure.code}, ${why})`,
  });
  if (!moved) return 'duplicate';

  postMove(ctx.db, {
    kind: 'refund', payoutId: payout.id, from: ACCOUNTS.inFlight, to: ACCOUNTS.refundsDue,
    amountMinor: payout.amount_minor, currency: payout.currency, at: now,
    description: `Release funds for failed payout to ${payout.employee_id}`,
  });
  return 'applied';
}

/** News about an attempt that is already closed. */
function handleClosedAttempt(
  ctx: AppContext,
  attempt: AttemptRow,
  payout: PayoutRow,
  outcome: AttemptOutcome,
  actor: Actor,
  meta: Record<string, unknown>,
): ApplyResult {
  if (outcome.kind === 'accepted' || outcome.kind === 'unknown') return 'stale';
  if (outcome.kind === attempt.status) return 'duplicate';

  // The provider now says the opposite of what it said before. The worst
  // version: an attempt we closed as failed (and maybe retried) now says
  // "succeeded", meaning money may have moved twice. Never auto-resolve this.
  return escalateConflict(
    ctx, payout, actor, meta, ctx.clock.now(),
    `CONFLICT: attempt ${attempt.attempt_number} was ${attempt.status}, provider now reports ${outcome.kind}`,
  );
}

function escalateConflict(ctx: AppContext, payout: PayoutRow, actor: Actor, meta: Record<string, unknown>, now: number, reason: string): ApplyResult {
  if (canTransition(payout.status, 'needs_review')) {
    transitionPayout(ctx.db, {
      payoutId: payout.id, from: payout.status, to: 'needs_review', actor, at: now, reason, metadata: meta, lastError: CONFLICT_MARKER,
    });
  } else {
    // Terminal payout (e.g. already succeeded): status stays, but the conflict is on record for ops.
    recordPayoutNote(ctx.db, { payoutId: payout.id, status: payout.status, actor, at: now, reason, metadata: meta });
  }
  return 'conflict';
}

function updateAttempt(ctx: AppContext, id: string, status: AttemptStatus, now: number, extra: { raw?: string } = {}): void {
  ctx.db
    .prepare(`UPDATE payout_attempts SET status = ?, raw_response = COALESCE(?, raw_response), updated_at = ? WHERE id = ? AND status IN ${OPEN}`)
    .run(status, extra.raw ?? null, now, id);
}

function closeAttempt(ctx: AppContext, id: string, status: 'succeeded' | 'failed', now: number, code?: string, retryable?: boolean): void {
  ctx.db
    .prepare(
      `UPDATE payout_attempts SET status = ?, failure_code = ?, failure_retryable = ?, updated_at = ?
        WHERE id = ? AND status IN ${OPEN}`,
    )
    .run(status, code ?? null, retryable === undefined ? null : Number(retryable), now, id);
}
