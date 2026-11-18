import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, accountBalance } from '../src/ledger';
import { createPayrollRun } from '../src/payrollService';
import { PayoutProcessor } from '../src/processor';
import { createMockSystem } from '../src/setup';

/**
 * The scariest case in payments: we asked the provider to pay, and the
 * response never came back. Did the money move? These tests prove we find
 * out by asking, rather than guessing, and never pay twice either way.
 */

async function setup() {
  const sys = createMockSystem();
  await createPayrollRun(sys.ctx, {
    companyId: 'co_acme', idempotencyKey: 'k1', fundingCurrency: 'USD',
    items: [{ employeeId: 'ada', amountMinor: 25_000_000, currency: 'NGN', recipient: { name: 'Ada', accountNumber: '0123456789' } }],
  });
  const processor = new PayoutProcessor(sys.ctx);
  const payout = () => sys.ctx.db.prepare(`SELECT * FROM payouts`).get() as any;
  const attempts = () => sys.ctx.db.prepare(`SELECT * FROM payout_attempts ORDER BY attempt_number`).all() as any[];
  const succeededTransfers = () => sys.mocks.ngn.allTransfers().filter((t) => t.status === 'succeeded');
  const waitForReconciler = () => sys.clock.advance(sys.ctx.config.staleAttemptMs);
  return { ...sys, processor, payout, attempts, succeededTransfers, waitForReconciler };
}

test('timeout AFTER the money moved: resolved by status check, never re-sent', async () => {
  const s = await setup();
  s.mocks.ngn.script('timeout_after_processing');

  await s.processor.tick();
  assert.equal(s.payout().status, 'processing', 'unknown outcome: we do NOT mark it failed');
  assert.equal(s.attempts()[0].status, 'unknown');

  // An immediate tick must not resend: the attempt isn't stale yet, and retrying
  // an unknown outcome with a new reference is exactly how double payments happen.
  await s.processor.tick();
  assert.equal(s.mocks.ngn.sendCalls, 1);

  s.waitForReconciler();
  await s.processor.tick();

  assert.equal(s.payout().status, 'succeeded');
  assert.equal(s.mocks.ngn.sendCalls, 1, 'resolved by asking, not by sending again');
  assert.equal(s.succeededTransfers().length, 1);
  assert.equal(s.attempts().length, 1);
  assert.equal(accountBalance(s.ctx.db, ACCOUNTS.paidToEmployees, 'NGN'), 25_000_000);
});

test('timeout BEFORE the request arrived: resent with the SAME reference, paid once', async () => {
  const s = await setup();
  s.mocks.ngn.script('timeout_before_processing', 'succeed');

  await s.processor.tick();
  s.waitForReconciler();
  await s.processor.tick();

  assert.equal(s.payout().status, 'succeeded');
  assert.equal(s.attempts().length, 1, 'no new attempt: the original reference was reused');
  assert.equal(s.mocks.ngn.sendCalls, 2);
  assert.equal(s.succeededTransfers().length, 1);
  assert.equal(s.succeededTransfers()[0]!.reference, s.attempts()[0].provider_reference);
});

test('crash between recording the attempt and calling the provider: recovers, paid once', async () => {
  const s = await setup();

  // Worker claims the payout and commits the attempt row... then the process dies.
  const claim = s.processor.claim(s.payout().id);
  assert.ok(claim);
  assert.equal(s.mocks.ngn.sendCalls, 0);

  // A fresh worker (after restart) picks it up through reconciliation.
  const restarted = new PayoutProcessor(s.ctx);
  await restarted.tick();
  assert.equal(s.mocks.ngn.sendCalls, 0, 'not stale yet: the original worker might still be mid-request');

  s.waitForReconciler();
  await restarted.tick();

  assert.equal(s.payout().status, 'succeeded');
  assert.equal(s.succeededTransfers().length, 1);
  assert.equal(s.succeededTransfers()[0]!.reference, claim.reference);
});

test('crash AFTER the provider paid but before we recorded it: recovers, paid once', async () => {
  const s = await setup();
  const claim = s.processor.claim(s.payout().id)!;

  // The request reaches the provider and money moves, then we die before writing the result.
  await s.mocks.ngn.sendPayout({ reference: claim.reference, amountMinor: claim.amountMinor, currency: claim.currency, recipient: claim.recipient });

  s.waitForReconciler();
  await new PayoutProcessor(s.ctx).tick();

  assert.equal(s.payout().status, 'succeeded');
  assert.equal(s.succeededTransfers().length, 1);
});

test('provider status API down for a long time: escalates to needs_review, keeps polling, self-heals', async () => {
  const s = await setup();
  const max = s.ctx.config.maxStatusChecks;
  s.mocks.ngn.script('timeout_after_processing');
  s.mocks.ngn.scriptStatus(...Array(max).fill('timeout'));

  await s.processor.tick();
  for (let i = 0; i < max; i++) {
    s.waitForReconciler();
    await s.processor.tick();
  }
  assert.equal(s.payout().status, 'needs_review');
  assert.equal(s.mocks.ngn.sendCalls, 1, 'still never resent');

  // Provider comes back: the next poll resolves it with no human needed.
  s.waitForReconciler();
  await s.processor.tick();
  assert.equal(s.payout().status, 'succeeded');
  assert.equal(s.succeededTransfers().length, 1);
});

test('accepted transfer whose webhook never arrives: polled until it settles', async () => {
  const s = await setup();
  s.mocks.ngn.script('accept');

  await s.processor.tick();
  assert.equal(s.attempts()[0].status, 'accepted');

  s.waitForReconciler();
  await s.processor.tick();
  assert.equal(s.payout().status, 'processing', 'provider still pending');

  s.mocks.ngn.settlePending(); // bank finishes; we ignore the webhook on purpose
  s.waitForReconciler();
  await s.processor.tick();
  assert.equal(s.payout().status, 'succeeded');
});

test('accepted, then the provider claims it never heard of it: escalated, not resent', async () => {
  const s = await setup();
  s.mocks.ngn.script('accept');
  await s.processor.tick();

  // Simulate the provider losing the record.
  s.mocks.ngn.getPayoutStatus = async () => ({ status: 'not_found' });
  s.waitForReconciler();
  await s.processor.tick();

  assert.equal(s.payout().status, 'needs_review');
  assert.equal(s.mocks.ngn.sendCalls, 1);
});
