import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, accountBalance } from '../src/ledger';
import { createPayrollRun } from '../src/payrollService';
import { PayoutProcessor } from '../src/processor';
import type { MockWebhookPayload } from '../src/providers/mockProvider';
import { createMockSystem } from '../src/setup';
import { handleWebhook } from '../src/webhooks';

async function setup() {
  const sys = createMockSystem();
  await createPayrollRun(sys.ctx, {
    companyId: 'co_acme', idempotencyKey: 'k1', fundingCurrency: 'USD',
    items: [{ employeeId: 'ada', amountMinor: 25_000_000, currency: 'NGN', recipient: { name: 'Ada', accountNumber: '0123456789' } }],
  });
  const processor = new PayoutProcessor(sys.ctx);
  const payout = () => sys.ctx.db.prepare(`SELECT * FROM payouts`).get() as any;
  const reference = () => sys.ctx.db.prepare(`SELECT provider_reference FROM payout_attempts ORDER BY attempt_number DESC`).pluck().get() as string;
  const deliver = (p: MockWebhookPayload) => handleWebhook(sys.ctx, 'paystack-mock', p);
  const hook = (id: string, event: MockWebhookPayload['event'], failure_code?: string): MockWebhookPayload => ({
    id, event, data: { reference: reference(), ...(failure_code ? { failure_code } : {}) },
  });
  const settleEntries = () => sys.ctx.db.prepare(`SELECT COUNT(*) FROM ledger_entries WHERE txn_id LIKE 'settle:%'`).pluck().get();
  return { ...sys, processor, payout, deliver, hook, settleEntries };
}

test('async payout: accepted on send, completed by webhook', async () => {
  const s = await setup();
  s.mocks.ngn.script('accept');
  await s.processor.tick();
  assert.equal(s.payout().status, 'processing');

  assert.equal(s.deliver(s.hook('evt_1', 'transfer.success')), 'applied');
  assert.equal(s.payout().status, 'succeeded');
  assert.equal(accountBalance(s.ctx.db, ACCOUNTS.paidToEmployees, 'NGN'), 25_000_000);
});

test('the exact same webhook delivered twice is processed once', async () => {
  const s = await setup();
  s.mocks.ngn.script('accept');
  await s.processor.tick();

  const event = s.hook('evt_1', 'transfer.success');
  assert.equal(s.deliver(event), 'applied');
  assert.equal(s.deliver(event), 'duplicate_event');
  assert.equal(s.settleEntries(), 2, 'one balanced settle pair, not two');
  assert.equal(s.ctx.db.prepare(`SELECT COUNT(*) FROM payout_events WHERE to_status = 'succeeded'`).pluck().get(), 1);
});

test('same news under a different event id is still a no-op', async () => {
  const s = await setup();
  s.mocks.ngn.script('accept');
  await s.processor.tick();

  s.deliver(s.hook('evt_1', 'transfer.success'));
  assert.equal(s.deliver(s.hook('evt_2', 'transfer.success')), 'duplicate');
  assert.equal(s.settleEntries(), 2);
});

test('webhook arrives BEFORE the send response: whichever is second is a harmless duplicate', async () => {
  const s = await setup();
  s.mocks.ngn.script('succeed');
  // Provider fires the webhook while our HTTP call is still waiting for its response.
  s.mocks.ngn.beforeResponse = () => {
    for (const w of s.mocks.ngn.drainWebhooks()) assert.equal(s.deliver(w), 'applied');
  };
  await s.processor.tick();

  assert.equal(s.payout().status, 'succeeded');
  assert.equal(s.settleEntries(), 2);
});

test('out of order: a late "pending" after "succeeded" changes nothing', async () => {
  const s = await setup();
  s.mocks.ngn.script('accept');
  await s.processor.tick();

  s.deliver(s.hook('evt_2', 'transfer.success'));
  assert.equal(s.deliver(s.hook('evt_1', 'transfer.pending')), 'stale');
  assert.equal(s.payout().status, 'succeeded');
});

test('contradiction: "failed" after "succeeded" is flagged, status and ledger untouched', async () => {
  const s = await setup();
  await s.processor.tick(); // succeeds synchronously

  assert.equal(s.deliver(s.hook('evt_9', 'transfer.failed', 'issuer_unavailable')), 'conflict');
  assert.equal(s.payout().status, 'succeeded');
  assert.equal(accountBalance(s.ctx.db, ACCOUNTS.paidToEmployees, 'NGN'), 25_000_000);
  const note = s.ctx.db.prepare(`SELECT reason FROM payout_events WHERE reason LIKE 'CONFLICT%'`).pluck().get();
  assert.match(String(note), /was succeeded, provider now reports failed/);
});

test('late success for an attempt we already treated as failed: retries stop, human review', async () => {
  const s = await setup();
  s.mocks.ngn.script('fail_retryable');
  await s.processor.tick();
  assert.equal(s.payout().status, 'awaiting_retry');

  // The provider changes its mind: attempt 1 actually went through.
  assert.equal(s.deliver(s.hook('evt_late', 'transfer.success')), 'conflict');
  assert.equal(s.payout().status, 'needs_review');

  // The retry that was scheduled must NOT happen: that would be a double payment.
  s.clock.advance(60 * 60_000);
  await s.processor.tick();
  assert.equal(s.mocks.ngn.sendCalls, 1);
});

test('webhook failure with a retryable code schedules a retry', async () => {
  const s = await setup();
  s.mocks.ngn.script('accept');
  await s.processor.tick();

  assert.equal(s.deliver(s.hook('evt_1', 'transfer.failed', 'issuer_unavailable')), 'applied');
  assert.equal(s.payout().status, 'awaiting_retry');
});

test('webhook for a reference we never created is stored but changes nothing', async () => {
  const s = await setup();
  const result = s.deliver({ id: 'evt_x', event: 'transfer.success', data: { reference: 'not_ours' } });
  assert.equal(result, 'unknown_reference');
  assert.equal(s.payout().status, 'pending');
  assert.equal(s.ctx.db.prepare(`SELECT outcome FROM webhook_events`).pluck().get(), 'unknown_reference');
});

test('malformed webhook is rejected without side effects', async () => {
  const s = await setup();
  assert.throws(() => handleWebhook(s.ctx, 'paystack-mock', { nonsense: true }), /Malformed/);
  assert.equal(s.ctx.db.prepare(`SELECT COUNT(*) FROM webhook_events`).pluck().get(), 0);
});
