import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, fundingRequired, money, parseRate, sumMoney } from '../src/money';

test('rejects non-integer, negative and unsafe amounts', () => {
  assert.throws(() => money(100.5, 'NGN'));
  assert.throws(() => money(-1, 'NGN'));
  assert.throws(() => money(Number.MAX_SAFE_INTEGER + 1, 'NGN'));
  assert.throws(() => money(100, 'XYZ' as never));
});

test('sumMoney refuses to mix currencies', () => {
  assert.deepEqual(sumMoney('KES', [money(150, 'KES'), money(250, 'KES')]), money(400, 'KES'));
  assert.throws(() => sumMoney('KES', [money(150, 'KES'), money(250, 'NGN')]), /mismatch/);
});

test('formatMoney is human-readable', () => {
  assert.equal(formatMoney(money(15_000_005, 'NGN')), 'NGN 150,000.05');
  assert.equal(formatMoney(money(7, 'GHS')), 'GHS 0.07');
});

test('parseRate is exact (no floating point)', () => {
  assert.deepEqual(parseRate('1550.25'), { numerator: 155025n, denominator: 100n });
  assert.deepEqual(parseRate('129'), { numerator: 129n, denominator: 1n });
  for (const bad of ['', 'abc', '-1', '1e3', '0', '0.000', '1,550']) {
    assert.throws(() => parseRate(bad), Error, `should reject "${bad}"`);
  }
});

test('fundingRequired converts exactly when it divides evenly', () => {
  // NGN 1,550.25 at 1 USD = 1550.25 NGN -> exactly USD 1.00
  const usd = fundingRequired(money(155_025, 'NGN'), { from: 'USD', to: 'NGN', rate: '1550.25' });
  assert.deepEqual(usd, money(100, 'USD'));
});

test('fundingRequired rounds UP so the company never under-funds', () => {
  // KES 100.00 at 129.5 KES/USD = USD 0.772200... -> 78 cents, not 77
  const usd = fundingRequired(money(10_000, 'KES'), { from: 'USD', to: 'KES', rate: '129.5' });
  assert.deepEqual(usd, money(78, 'USD'));

  // And the rounded-up funding always covers the target when converted back
  const coveredKesMinor = (usd.amountMinor * 1295) / 10;
  assert.ok(coveredKesMinor >= 10_000);
});

test('fundingRequired handles payroll-sized amounts without precision loss', () => {
  // NGN 5 billion (500 billion kobo): float maths would already be drifting here
  const usd = fundingRequired(money(500_000_000_000, 'NGN'), { from: 'USD', to: 'NGN', rate: '1543.123456' });
  // 500_000_000_000 * 1_000_000 / 1_543_123_456 = 324_018_145.018... -> ceil to 324_018_146
  assert.deepEqual(usd, money(324_018_146, 'USD'));
});

test('fundingRequired rejects a rate for the wrong currency', () => {
  assert.throws(() => fundingRequired(money(100, 'GHS'), { from: 'USD', to: 'NGN', rate: '1500' }), /cannot fund/);
});
