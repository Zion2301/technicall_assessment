import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../src/clock';
import { MockProvider } from '../src/providers/mockProvider';
import { ProviderRegistry } from '../src/providers/registry';
import { ProviderTimeoutError } from '../src/providers/types';

const req = { reference: 'ref_1', amountMinor: 50_000, currency: 'NGN' as const, recipient: { name: 'Ada', accountNumber: '0123456789' } };
const make = () => new MockProvider({ name: 'paystack-mock', currencies: ['NGN'], random: seededRandom(1) });

test('mock is idempotent on reference: resending moves no new money', async () => {
  const p = make();
  await p.sendPayout(req);
  await p.sendPayout(req);
  assert.equal(p.sendCalls, 2);
  assert.equal(p.allTransfers().length, 1);
});

test('reusing a reference with a different amount is rejected', async () => {
  const p = make();
  await p.sendPayout(req);
  const res = await p.sendPayout({ ...req, amountMinor: 99_999 });
  assert.deepEqual(res.outcome === 'failed' && [res.code, res.retryable], ['reference_conflict', false]);
});

test('timeout_after_processing: money moves even though the caller sees a timeout', async () => {
  const p = make().script('timeout_after_processing');
  await assert.rejects(p.sendPayout(req), ProviderTimeoutError);
  assert.deepEqual(await p.getPayoutStatus('ref_1'), { status: 'succeeded' });
});

test('timeout_before_processing: nothing recorded, status says not_found', async () => {
  const p = make().script('timeout_before_processing');
  await assert.rejects(p.sendPayout(req), ProviderTimeoutError);
  assert.deepEqual(await p.getPayoutStatus('ref_1'), { status: 'not_found' });
});

test('accepted transfers settle later and emit a webhook in the provider wire format', async () => {
  const p = make().script('accept');
  assert.equal((await p.sendPayout(req)).outcome, 'accepted');
  p.drainWebhooks(); // discard the transfer.pending event
  p.settlePending();
  const [hook] = p.drainWebhooks();
  assert.deepEqual(p.parseWebhook(hook), { eventId: hook!.id, reference: 'ref_1', status: 'succeeded', failureCode: undefined, retryable: undefined });
});

test('registry routes by currency', () => {
  const ngn = make();
  const kes = new MockProvider({ name: 'mpesa-mock', currencies: ['KES'], random: seededRandom(2) });
  const registry = new ProviderRegistry([ngn, kes]);
  assert.equal(registry.forCurrency('KES').name, 'mpesa-mock');
  assert.throws(() => registry.forCurrency('GHS'), /No payout provider/);
});
