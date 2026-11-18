import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, accountBalance, unbalancedTransactions } from '../src/ledger';
import type { Currency } from '../src/money';
import {
  createPayrollRun,
  type CreatePayrollRunInput,
  getRunSummary,
  IdempotencyConflictError,
  type PayrollItem,
  ValidationError,
} from '../src/payrollService';
import { createMockSystem } from '../src/setup';

const item = (employeeId: string, amountMinor: number, currency: Currency = 'NGN'): PayrollItem => ({
  employeeId,
  amountMinor,
  currency,
  recipient: { name: `Employee ${employeeId}`, accountNumber: `acct_${employeeId}` },
});

const request = (overrides: Partial<CreatePayrollRunInput> = {}): CreatePayrollRunInput => ({
  companyId: 'co_acme',
  idempotencyKey: 'payroll-2026-01',
  fundingCurrency: 'USD',
  items: [item('ada', 25_000_000, 'NGN'), item('wanjiru', 15_000_000, 'KES'), item('kofi', 800_000, 'GHS')],
  ...overrides,
});

const count = (ctx: { db: any }, table: string) => ctx.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

test('creates a run with one pending payout per item, routed to the right provider', async () => {
  const { ctx } = createMockSystem();
  const { runId, created } = await createPayrollRun(ctx, request());

  assert.equal(created, true);
  const payouts = ctx.db.prepare(`SELECT employee_id, currency, provider, status FROM payouts ORDER BY employee_id`).all();
  assert.deepEqual(payouts, [
    { employee_id: 'ada', currency: 'NGN', provider: 'paystack-mock', status: 'pending' },
    { employee_id: 'kofi', currency: 'GHS', provider: 'flutterwave-mock', status: 'pending' },
    { employee_id: 'wanjiru', currency: 'KES', provider: 'mpesa-mock', status: 'pending' },
  ]);
  assert.equal(getRunSummary(ctx, runId).status, 'in_progress');
});

test('client idempotency: retrying the same request returns the same run and creates nothing new', async () => {
  const { ctx } = createMockSystem();
  const first = await createPayrollRun(ctx, request());
  const second = await createPayrollRun(ctx, request());
  // Same items in a different order is still the same request
  const third = await createPayrollRun(ctx, request({ items: [...request().items].reverse() }));

  assert.equal(second.runId, first.runId);
  assert.equal(third.runId, first.runId);
  assert.equal(second.created, false);
  assert.equal(count(ctx, 'payroll_runs'), 1);
  assert.equal(count(ctx, 'payouts'), 3);
  assert.equal(count(ctx, 'ledger_entries'), 6); // one reserve pair per payout, not per request
});

test('concurrent identical requests still produce exactly one run', async () => {
  const { ctx } = createMockSystem();
  const results = await Promise.all([createPayrollRun(ctx, request()), createPayrollRun(ctx, request())]);
  assert.equal(results[0].runId, results[1].runId);
  assert.deepEqual(results.map((r) => r.created).sort(), [false, true]);
  assert.equal(count(ctx, 'payouts'), 3);
});

test('same idempotency key with a different body is rejected', async () => {
  const { ctx } = createMockSystem();
  await createPayrollRun(ctx, request());
  await assert.rejects(
    createPayrollRun(ctx, request({ items: [item('ada', 99_999_999, 'NGN')] })),
    IdempotencyConflictError,
  );
});

test('a new idempotency key is a new run (e.g. an intentional off-cycle bonus run)', async () => {
  const { ctx } = createMockSystem();
  const a = await createPayrollRun(ctx, request());
  const b = await createPayrollRun(ctx, request({ idempotencyKey: 'bonus-2026-01' }));
  assert.notEqual(a.runId, b.runId);
});

test('locks one FX quote per currency and rounds funding up', async () => {
  const { ctx } = createMockSystem();
  const { runId } = await createPayrollRun(
    ctx,
    request({ items: [item('a', 10_000, 'KES'), item('b', 5_000, 'KES'), item('c', 155_025, 'NGN')] }),
  );
  const quotes = getRunSummary(ctx, runId).fxQuotes as any[];

  assert.deepEqual(
    quotes.map((q) => [q.to_currency, q.rate, q.target_total_minor, q.funding_minor]),
    [
      ['KES', '129.5', 15_000, 116], // KES 150.00 / 129.5 = USD 1.1583 -> 1.16
      ['NGN', '1550.25', 155_025, 100], // exact: USD 1.00
    ],
  );
});

test('ledger: each payout reserves its exact amount, and every transaction balances', async () => {
  const { ctx } = createMockSystem();
  await createPayrollRun(ctx, request());

  assert.equal(accountBalance(ctx.db, ACCOUNTS.inFlight, 'NGN'), 25_000_000);
  assert.equal(accountBalance(ctx.db, ACCOUNTS.inFlight, 'KES'), 15_000_000);
  assert.equal(accountBalance(ctx.db, ACCOUNTS.companyFunding, 'GHS'), -800_000);
  assert.deepEqual(unbalancedTransactions(ctx.db), []);
});

test('validation rejects bad input before anything is written', async () => {
  const { ctx } = createMockSystem();
  const cases: Partial<CreatePayrollRunInput>[] = [
    { idempotencyKey: '' },
    { items: [] },
    { items: [item('ada', 100), item('ada', 200)] }, // duplicate employee
    { items: [item('ada', 100.5)] }, // fractional kobo
    { items: [item('ada', 0)] },
    { items: [item('ada', 100, 'USD')] }, // no provider pays out USD
    { items: [{ ...item('ada', 100), recipient: { name: 'Ada', accountNumber: '' } }] },
  ];
  for (const c of cases) {
    await assert.rejects(createPayrollRun(ctx, request(c)), ValidationError, JSON.stringify(c));
  }
  assert.equal(count(ctx, 'payroll_runs'), 0);
});
