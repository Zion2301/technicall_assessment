import type { DB } from './db';
import { assertTransition, type PayoutStatus } from './stateMachine';

export type Actor = 'api' | 'processor' | 'webhook' | 'reconciler' | 'operator';

export interface TransitionInput {
  payoutId: string;
  from: PayoutStatus;
  to: PayoutStatus;
  actor: Actor;
  reason: string;
  at: number;
  metadata?: Record<string, unknown>;
  nextAttemptAt?: number | null;
  lastError?: string | null;
}

/**
 * The ONLY way a payout's status changes. It does three things atomically:
 *
 *  1. Checks the state machine (illegal transition -> throws).
 *  2. Compare-and-swap: `UPDATE ... WHERE status = <from>`. If another worker
 *     or webhook already moved the payout, 0 rows change and we return false.
 *     The caller then knows it lost the race and must not continue.
 *  3. Appends an audit event, so every change is explained.
 *
 * Callers wrap this in a larger transaction when the status change must be
 * atomic with other writes (e.g. ledger entries). better-sqlite3 turns a
 * nested transaction into a savepoint, so that composes safely.
 */
export function transitionPayout(db: DB, t: TransitionInput): boolean {
  assertTransition(t.from, t.to);

  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE payouts
            SET status = ?,
                next_attempt_at = ?,
                last_error = COALESCE(?, last_error),
                updated_at = ?
          WHERE id = ? AND status = ?`,
      )
      .run(t.to, t.nextAttemptAt ?? null, t.lastError ?? null, t.at, t.payoutId, t.from);

    if (result.changes === 0) return false; // lost the race: someone else moved it first

    db.prepare(
      `INSERT INTO payout_events (payout_id, from_status, to_status, actor, reason, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.payoutId, t.from, t.to, t.actor, t.reason, t.metadata ? JSON.stringify(t.metadata) : null, t.at);

    return true;
  })();
}

/**
 * Records something noteworthy that does NOT change status, e.g. a webhook
 * contradicting a payout that has already succeeded. Shows up in the audit
 * trail with from_status = to_status.
 */
export function recordPayoutNote(
  db: DB,
  n: { payoutId: string; status: PayoutStatus; actor: Actor; reason: string; at: number; metadata?: Record<string, unknown> },
): void {
  db.prepare(
    `INSERT INTO payout_events (payout_id, from_status, to_status, actor, reason, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(n.payoutId, n.status, n.status, n.actor, n.reason, n.metadata ? JSON.stringify(n.metadata) : null, n.at);
}
