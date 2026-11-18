import type { DB } from './db';
import { ACCOUNTS, accountBalance, unbalancedTransactions } from './ledger';
import { CURRENCIES, type Currency } from './money';

/** One line of a provider's settlement report: what the provider says actually happened. */
export interface ProviderTransferRecord {
  provider: string;
  reference: string;
  amountMinor: number;
  currency: Currency;
  status: 'pending' | 'succeeded' | 'failed';
}

/**
 * Cross-checks our records against the provider's records and against
 * themselves. This is the shape of a daily reconciliation job: in production
 * `transfers` would come from each provider's settlement report or bank
 * statement. Here it comes from the mocks.
 *
 * Returns human-readable violations. Empty means every check passed.
 */
export function checkInvariants(db: DB, transfers: ProviderTransferRecord[]): string[] {
  const violations: string[] = [];

  // 1. Double-entry: every ledger transaction sums to zero.
  for (const txn of unbalancedTransactions(db)) violations.push(`Ledger transaction ${txn} does not balance`);

  const payouts = db.prepare(`SELECT id, status, amount_minor, currency FROM payouts`).all() as {
    id: string; status: string; amount_minor: number; currency: Currency;
  }[];
  const attempts = db.prepare(`SELECT payout_id, provider, provider_reference FROM payout_attempts`).all() as {
    payout_id: string; provider: string; provider_reference: string;
  }[];
  const payoutByRef = new Map(attempts.map((a) => [`${a.provider}:${a.provider_reference}`, a.payout_id]));
  const payoutById = new Map(payouts.map((p) => [p.id, p]));

  // 2. Every movement of money at the provider traces back to one of our attempts.
  const successesByPayout = new Map<string, ProviderTransferRecord[]>();
  for (const t of transfers) {
    const payoutId = payoutByRef.get(`${t.provider}:${t.reference}`);
    if (!payoutId) {
      violations.push(`Provider transfer ${t.provider}:${t.reference} has no matching attempt (orphan money)`);
      continue;
    }
    if (t.status !== 'succeeded') continue;
    successesByPayout.set(payoutId, [...(successesByPayout.get(payoutId) ?? []), t]);

    // 3. The amount that left is exactly the amount we were asked to pay.
    const p = payoutById.get(payoutId)!;
    if (t.amountMinor !== p.amount_minor || t.currency !== p.currency) {
      violations.push(`WRONG AMOUNT on ${payoutId}: owed ${p.amount_minor} ${p.currency}, provider sent ${t.amountMinor} ${t.currency}`);
    }
  }

  // 4. Nobody is paid twice, and our status agrees with what the provider did.
  for (const p of payouts) {
    const paid = successesByPayout.get(p.id)?.length ?? 0;
    if (paid > 1) violations.push(`DOUBLE PAYMENT: ${p.id} was paid ${paid} times`);
    if (p.status === 'succeeded' && paid !== 1) violations.push(`${p.id} is succeeded but the provider shows ${paid} successful transfers`);
    if (p.status === 'failed' && paid !== 0) violations.push(`${p.id} is failed but the provider actually paid it`);
  }

  // 5. Ledger balances agree with payout statuses, per currency.
  for (const currency of Object.keys(CURRENCIES) as Currency[]) {
    const sum = (statuses: string[]) =>
      payouts.filter((p) => p.currency === currency && statuses.includes(p.status)).reduce((s, p) => s + p.amount_minor, 0);
    const checks: [string, number, number][] = [
      [ACCOUNTS.paidToEmployees, accountBalance(db, ACCOUNTS.paidToEmployees, currency), sum(['succeeded'])],
      [ACCOUNTS.refundsDue, accountBalance(db, ACCOUNTS.refundsDue, currency), sum(['failed'])],
      [ACCOUNTS.inFlight, accountBalance(db, ACCOUNTS.inFlight, currency), sum(['pending', 'processing', 'awaiting_retry', 'needs_review'])],
    ];
    for (const [account, actual, expected] of checks) {
      if (actual !== expected) violations.push(`Ledger ${account} ${currency} is ${actual}, payouts say ${expected}`);
    }
  }

  return violations;
}
