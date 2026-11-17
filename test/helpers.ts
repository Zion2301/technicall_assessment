import type { DB } from '../src/db';
import type { PayoutStatus } from '../src/stateMachine';

/** Inserts a bare run + payout directly, for testing lower-level pieces in isolation. */
export function insertTestPayout(
  db: DB,
  opts: { id?: string; runId?: string; employeeId?: string; status?: PayoutStatus; amountMinor?: number } = {},
): string {
  const runId = opts.runId ?? 'run_test';
  const id = opts.id ?? 'po_test';
  db.prepare(
    `INSERT OR IGNORE INTO payroll_runs (id, company_id, idempotency_key, request_hash, funding_currency, created_at)
     VALUES (?, 'co_test', ?, 'hash', 'USD', 0)`,
  ).run(runId, `key_${runId}`);
  db.prepare(
    `INSERT INTO payouts (id, payroll_run_id, employee_id, amount_minor, currency, provider, recipient_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'NGN', 'paystack-mock', '{}', ?, 0, 0)`,
  ).run(id, runId, opts.employeeId ?? 'emp_1', opts.amountMinor ?? 100_000, opts.status ?? 'pending');
  return id;
}
