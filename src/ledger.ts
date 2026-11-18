import type { DB } from './db';
import type { Currency } from './money';

/**
 * A minimal double-entry ledger. Money is never created or destroyed, only
 * moved between accounts: every movement writes two entries (-X from one
 * account, +X to another), so each transaction sums to zero.
 *
 * The lifecycle of one payout's money:
 *
 *   run created:   company_funding  ──► payouts_in_flight
 *   succeeded:     payouts_in_flight ──► paid_to_employees
 *   failed:        payouts_in_flight ──► refunds_due_to_company
 *
 * So at any moment: in-flight balance = sum of payouts not yet finished, and
 * paid_to_employees = sum of succeeded payouts. The invariant checks rely on this.
 *
 * Simplification: accounts aren't scoped per company here. In production
 * they would be (e.g. "company:co_123:in_flight").
 */
export const ACCOUNTS = {
  companyFunding: 'company_funding',
  inFlight: 'payouts_in_flight',
  paidToEmployees: 'paid_to_employees',
  refundsDue: 'refunds_due_to_company',
} as const;

export type LedgerKind = 'reserve' | 'settle' | 'refund';

export interface LedgerMove {
  kind: LedgerKind;
  payoutId: string;
  from: string;
  to: string;
  amountMinor: number;
  currency: Currency;
  description: string;
  at: number;
}

/**
 * Posts one balanced movement. The txn_id is deterministic ("settle:po_123"),
 * so if buggy code ever tried to settle the same payout twice, the
 * UNIQUE(txn_id, account) constraint would reject it.
 */
export function postMove(db: DB, m: LedgerMove): void {
  if (!Number.isSafeInteger(m.amountMinor) || m.amountMinor <= 0) {
    throw new Error(`Ledger amount must be a positive integer, got ${m.amountMinor}`);
  }
  const txnId = `${m.kind}:${m.payoutId}`;
  const insert = db.prepare(
    `INSERT INTO ledger_entries (txn_id, account, currency, amount_minor, payout_id, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    insert.run(txnId, m.from, m.currency, -m.amountMinor, m.payoutId, m.description, m.at);
    insert.run(txnId, m.to, m.currency, m.amountMinor, m.payoutId, m.description, m.at);
  })();
}

export function accountBalance(db: DB, account: string, currency: Currency): number {
  return db
    .prepare(`SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries WHERE account = ? AND currency = ?`)
    .pluck()
    .get(account, currency) as number;
}

/** Transactions whose entries don't sum to zero. Should always be empty. */
export function unbalancedTransactions(db: DB): string[] {
  return db
    .prepare(`SELECT txn_id FROM ledger_entries GROUP BY txn_id, currency HAVING SUM(amount_minor) <> 0`)
    .pluck()
    .all() as string[];
}
