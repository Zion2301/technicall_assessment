import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, accountBalance } from '../src/ledger';
import { createPayrollRun } from '../src/payrollService';
import { PayoutProcessor } from '../src/processor';
import { backoffDelay, DEFAULT_RETRY_POLICY } from '../src/retry';
import { createMockSystem } from '../src/setup';

async function oneNairaPayout(amountMinor = 25_000_000) {
  const sys = createMockSystem();
  await createPayrollRun(sys.ctx, {
    companyId: 'co_acme', idempotencyKey: 'k1', fundingCurrency: 'USD',
    items: [{ employeeId: 'ada', amountMinor, currency: 'NGN', recipient: { name: 'Ada', accountNumber: '0123456789' } }],
  });
  const payout = () => sys.ctx.db.prepare(`SELECT * FROM payouts`).get() as any;
  const attempts = () => sys.ctx.db.prepare(`SELECT attempt_number, provider_reference, status, failure_code FROM payout_attempts ORDER BY attempt_number`).all() as any[];
  return { ...sys, processor: new PayoutProcessor(sys.ctx), payout, attempts };
}

test('backoff grows exponentially, stays within jitter bounds, and is capped', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1000, maxDelayMs: 10_000 };
  for (const r of [0, 0.5, 0.999]) {
    const random = () => r;
    assert.ok(backoffDelay(1, policy, random) >= 500 && backoffDelay(1, policy, random) <= 1000);
    assert.ok(backoffDelay(3, policy, random) >= 2000 && backoffDelay(3, policy, random) <= 4000);
    assert.ok(backoffDelay(10, policy, random) <= 10_000); // capped
  }
});

test('happy path: one attempt, payout succeeded, money moves from in-flight to paid', async () => {
  const s = await oneNairaPayout();
  await s.processor.tick();

  assert.equal(s.payout().status, 'succeeded');
  assert.equal(s.attempts().length, 1);
  assert.equal(accountBalance(s.ctx.db, ACCOUNTS.inFlight, 'NGN'), 0);
  assert.equal(accountBalance(s.ctx.db, ACCOUNTS.paidToEmployees, 'NGN'), 25_000_000);
  // The provider received exactly the amount we were asked to pay.
  assert.deepEqual(s.mocks.ngn.allTransfers().map((t) => t.amountMinor), [25_000_000]);
});

test('retryable failure: waits for backoff, retries with a NEW reference, then succeeds', async () => {
  const s = await oneNairaPayout();
  s.mocks.ngn.script('fail_retryable', 'succeed');

  await s.processor.tick();
  assert.equal(s.payout().status, 'awaiting_retry');
  const retryAt = s.payout().next_attempt_at;
  assert.ok(retryAt > s.clock.now());

  // Not due yet: nothing happens
  await s.processor.tick();
  assert.equal(s.mocks.ngn.sendCalls, 1);

  s.clock.advance(retryAt - s.clock.now());
  await s.processor.tick();

  assert.equal(s.payout().status, 'succeeded');
  const attempts = s.attempts();
  assert.deepEqual(attempts.map((a) => a.status), ['failed', 'succeeded']);
  assert.notEqual(attempts[0].provider_reference, attempts[1].provider_reference);
  assert.equal(s.mocks.ngn.allTransfers().filter((t) => t.status === 'succeeded').length, 1);
});

test('retries exhausted: payout fails and the reserved funds are released', async () => {
  const s = await oneNairaPayout();
  s.mocks.ngn.script('fail_retryable', 'fail_retryable', 'fail_retryable', 'fail_retryable');

  for (let i = 0; i < 10; i++) {
    await s.processor.tick();
    s.clock.advance(DEFAULT_RETRY_POLICY.maxDelayMs);
  }

  assert.equal(s.payout().status, 'failed');
  assert.equal(s.attempts().length, DEFAULT_RETRY_POLICY.maxAttempts);
  assert.equal(accountBalance(s.ctx.db, ACCOUNTS.inFlight, 'NGN'), 0);
  assert.equal(accountBalance(s.ctx.db, ACCOUNTS.refundsDue, 'NGN'), 25_000_000);
  assert.equal(accountBalance(s.ctx.db, ACCOUNTS.paidToEmployees, 'NGN'), 0);
});

test('non-retryable failure (bad account): fails immediately, no retry', async () => {
  const s = await oneNairaPayout();
  s.mocks.ngn.script('fail_permanent');

  await s.processor.tick();
  s.clock.advance(DEFAULT_RETRY_POLICY.maxDelayMs);
  await s.processor.tick();

  assert.equal(s.payout().status, 'failed');
  assert.equal(s.payout().last_error, 'invalid_account');
  assert.equal(s.mocks.ngn.sendCalls, 1);
});

test('two workers racing over the same payouts: each payout is sent exactly once', async () => {
  const sys = createMockSystem();
  await createPayrollRun(sys.ctx, {
    companyId: 'co_acme', idempotencyKey: 'k1', fundingCurrency: 'USD',
    items: Array.from({ length: 20 }, (_, i) => ({
      employeeId: `emp_${i}`, amountMinor: 100_000 + i, currency: 'NGN' as const, recipient: { name: `E${i}`, accountNumber: `${i}` },
    })),
  });

  const workerA = new PayoutProcessor(sys.ctx);
  const workerB = new PayoutProcessor(sys.ctx);
  const [sentA, sentB] = await Promise.all([workerA.processDuePayouts(), workerB.processDuePayouts()]);

  assert.equal(sentA + sentB, 20);
  assert.ok(sentA > 0 && sentB > 0, 'both workers did some of the work');
  assert.equal(sys.mocks.ngn.sendCalls, 20);
  assert.equal(sys.mocks.ngn.allTransfers().length, 20);
});
