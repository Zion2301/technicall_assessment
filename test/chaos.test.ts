import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db';
import { checkInvariants } from '../src/invariants';
import { simulatePayroll } from '../src/simulation';
import { insertTestPayout } from './helpers';

/**
 * The strongest test in the suite: full payrolls against providers that time
 * out, fail, lose webhooks and send duplicates, across several random seeds.
 * Whatever happens, the invariants must hold.
 */
for (const seed of [1, 2, 3, 4, 5]) {
  test(`chaos payroll (seed ${seed}): nobody paid twice, amounts exact, ledger balanced`, async () => {
    const r = await simulatePayroll({ seed, employees: 300 });

    assert.deepEqual(r.violations, []);
    assert.ok(r.clientRetryReturnedSameRun);
    assert.equal(r.summary.counts.pending + r.summary.counts.processing + r.summary.counts.awaiting_retry + r.summary.counts.needs_review, 0, 'every payout finished');
    assert.ok(r.summary.counts.succeeded > 250);

    // Prove the chaos actually exercised the hard paths (not a vacuous pass).
    const attempts = r.ctx.db.prepare(`SELECT COUNT(*) FROM payout_attempts WHERE attempt_number > 1`).pluck().get() as number;
    const resolvedUnknowns = r.ctx.db.prepare(`SELECT COUNT(*) FROM payout_events WHERE reason LIKE 'Outcome unknown%'`).pluck().get() as number;
    assert.ok(attempts > 0, 'some payouts were retried');
    assert.ok(resolvedUnknowns > 20, 'many timeouts had to be resolved');
    assert.ok((r.webhookResults.duplicate_event ?? 0) > 0, 'duplicate webhooks arrived');
    assert.ok((r.webhookResults.duplicate ?? 0) + (r.webhookResults.stale ?? 0) > 0, 'redundant / out-of-order news arrived');
  });
}

test('the invariant checker is not vacuous: it catches a double payment and a wrong amount', () => {
  const db = openDb();
  const payoutId = insertTestPayout(db, { status: 'succeeded', amountMinor: 100_000 });
  const addAttempt = db.prepare(
    `INSERT INTO payout_attempts (id, payout_id, attempt_number, provider, provider_reference, status, created_at, updated_at)
     VALUES (?, ?, ?, 'paystack-mock', ?, 'succeeded', 0, 0)`,
  );
  addAttempt.run('a1', payoutId, 1, 'ref_1');
  addAttempt.run('a2', payoutId, 2, 'ref_2');

  const violations = checkInvariants(db, [
    { provider: 'paystack-mock', reference: 'ref_1', amountMinor: 100_000, currency: 'NGN', status: 'succeeded' },
    { provider: 'paystack-mock', reference: 'ref_2', amountMinor: 100_001, currency: 'NGN', status: 'succeeded' },
    { provider: 'paystack-mock', reference: 'ref_stranger', amountMinor: 5, currency: 'NGN', status: 'succeeded' },
  ]);

  assert.ok(violations.some((v) => v.startsWith('DOUBLE PAYMENT')));
  assert.ok(violations.some((v) => v.startsWith('WRONG AMOUNT')));
  assert.ok(violations.some((v) => v.includes('orphan money')));
});
