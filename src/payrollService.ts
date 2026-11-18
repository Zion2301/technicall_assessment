import { createHash, randomUUID } from 'node:crypto';
import type { AppContext } from './context';
import { ACCOUNTS, postMove } from './ledger';
import { type Currency, formatMoney, fundingRequired, isCurrency, money, sumMoney } from './money';
import type { Recipient } from './providers/types';
import type { PayoutStatus } from './stateMachine';

/**
 * One line of a payroll run: a payment instruction. Net pay is calculated
 * upstream (gross, tax, pension, statutory deductions); this system's job is
 * to move that exact amount reliably.
 */
export interface PayrollItem {
  employeeId: string;
  amountMinor: number;
  currency: Currency;
  recipient: Recipient;
}

export interface CreatePayrollRunInput {
  companyId: string;
  /** Client-generated, e.g. one per "Run payroll" button click. Retrying the same request reuses it. */
  idempotencyKey: string;
  fundingCurrency: Currency;
  items: PayrollItem[];
}

export class ValidationError extends Error {}

/** Same idempotency key, different request body: almost certainly a client bug, so refuse loudly. */
export class IdempotencyConflictError extends Error {}

/**
 * Creates a payroll run, its payouts and FX quotes, idempotently.
 *
 * - Same key + same body  -> returns the original run (created: false). Safe to retry.
 * - Same key + other body -> IdempotencyConflictError.
 *
 * Everything is written in ONE transaction: either the whole run exists, with
 * every payout and its ledger reservation, or none of it does.
 */
export async function createPayrollRun(
  ctx: AppContext,
  input: CreatePayrollRunInput,
): Promise<{ runId: string; created: boolean }> {
  validate(ctx, input);
  const requestHash = hashRequest(input);

  // Fast path for retries: don't fetch new FX quotes for a request we've already handled.
  const existing = findRun(ctx, input);
  if (existing) return replay(existing, requestHash);

  // Lock FX quotes before the transaction (in production this is a network call,
  // and network calls don't belong inside a DB transaction).
  const currencies = [...new Set(input.items.map((i) => i.currency))];
  const quotes = await Promise.all(
    currencies.map(async (currency) => ({ currency, ...(await ctx.fx.quote(input.fundingCurrency, currency)) })),
  );

  const now = ctx.clock.now();
  const runId = `run_${randomUUID()}`;

  return ctx.db.transaction(() => {
    // INSERT ... ON CONFLICT DO NOTHING closes the race where two identical
    // requests both pass the check above: only one insert can win.
    const inserted = ctx.db
      .prepare(
        `INSERT INTO payroll_runs (id, company_id, idempotency_key, request_hash, funding_currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, idempotency_key) DO NOTHING`,
      )
      .run(runId, input.companyId, input.idempotencyKey, requestHash, input.fundingCurrency, now);
    if (inserted.changes === 0) return replay(findRun(ctx, input)!, requestHash);

    for (const q of quotes) {
      const total = sumMoney(
        q.currency,
        input.items.filter((i) => i.currency === q.currency).map((i) => money(i.amountMinor, i.currency)),
      );
      const funding = fundingRequired(total, { from: input.fundingCurrency, to: q.currency, rate: q.rate });
      ctx.db
        .prepare(
          `INSERT INTO fx_quotes (id, payroll_run_id, from_currency, to_currency, rate, source, target_total_minor, funding_minor, locked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(`fxq_${randomUUID()}`, runId, input.fundingCurrency, q.currency, q.rate, q.source, total.amountMinor, funding.amountMinor, now);
    }

    const insertPayout = ctx.db.prepare(
      `INSERT INTO payouts (id, payroll_run_id, employee_id, amount_minor, currency, provider, recipient_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    const insertEvent = ctx.db.prepare(
      `INSERT INTO payout_events (payout_id, from_status, to_status, actor, reason, metadata, created_at)
       VALUES (?, NULL, 'pending', 'api', ?, ?, ?)`,
    );

    for (const item of input.items) {
      const payoutId = `po_${randomUUID()}`;
      const provider = ctx.providers.forCurrency(item.currency).name;
      insertPayout.run(payoutId, runId, item.employeeId, item.amountMinor, item.currency, provider, JSON.stringify(item.recipient), now, now);
      insertEvent.run(
        payoutId,
        `Created in payroll run ${runId}`,
        JSON.stringify({ idempotencyKey: input.idempotencyKey, provider }),
        now,
      );
      postMove(ctx.db, {
        kind: 'reserve',
        payoutId,
        from: ACCOUNTS.companyFunding,
        to: ACCOUNTS.inFlight,
        amountMinor: item.amountMinor,
        currency: item.currency,
        description: `Reserve ${formatMoney(money(item.amountMinor, item.currency))} for ${item.employeeId}`,
        at: now,
      });
    }

    return { runId, created: true };
  })();
}

function validate(ctx: AppContext, input: CreatePayrollRunInput): void {
  if (!input.idempotencyKey?.trim()) throw new ValidationError('idempotencyKey is required');
  if (!isCurrency(input.fundingCurrency)) throw new ValidationError(`Unsupported funding currency ${input.fundingCurrency}`);
  if (input.items.length === 0) throw new ValidationError('A payroll run needs at least one item');

  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.employeeId)) throw new ValidationError(`Employee ${item.employeeId} appears twice in this run`);
    seen.add(item.employeeId);
    try {
      money(item.amountMinor, item.currency);
      if (item.amountMinor === 0) throw new Error('amount must be greater than zero');
      ctx.providers.forCurrency(item.currency);
    } catch (err) {
      throw new ValidationError(`Invalid item for ${item.employeeId}: ${(err as Error).message}`);
    }
    if (!item.recipient?.name || !item.recipient?.accountNumber) {
      throw new ValidationError(`Missing recipient details for ${item.employeeId}`);
    }
  }
}

/** Order-insensitive fingerprint of the request, so "same key, different body" can be detected. */
function hashRequest(input: CreatePayrollRunInput): string {
  const items = [...input.items]
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))
    .map((i) => [i.employeeId, i.amountMinor, i.currency, i.recipient.name, i.recipient.accountNumber, i.recipient.bankCode ?? null]);
  const canonical = JSON.stringify([input.companyId, input.fundingCurrency, items]);
  return createHash('sha256').update(canonical).digest('hex');
}

function findRun(ctx: AppContext, input: CreatePayrollRunInput) {
  return ctx.db
    .prepare(`SELECT id, request_hash FROM payroll_runs WHERE company_id = ? AND idempotency_key = ?`)
    .get(input.companyId, input.idempotencyKey) as { id: string; request_hash: string } | undefined;
}

function replay(existing: { id: string; request_hash: string }, requestHash: string) {
  if (existing.request_hash !== requestHash) {
    throw new IdempotencyConflictError('Idempotency key was already used for a different payroll request');
  }
  return { runId: existing.id, created: false };
}

// ---------------------------------------------------------------------------
// Run summary: the run's status is DERIVED from its payouts, never stored,
// so it can't drift out of sync with them.
// ---------------------------------------------------------------------------

export type RunStatus = 'in_progress' | 'needs_attention' | 'completed' | 'completed_with_failures';

export function getRunSummary(ctx: AppContext, runId: string) {
  const rows = ctx.db
    .prepare(`SELECT status, COUNT(*) AS n FROM payouts WHERE payroll_run_id = ? GROUP BY status`)
    .all(runId) as { status: PayoutStatus; n: number }[];
  const counts: Record<PayoutStatus, number> = {
    pending: 0, processing: 0, awaiting_retry: 0, succeeded: 0, failed: 0, needs_review: 0,
  };
  for (const r of rows) counts[r.status] = r.n;

  let status: RunStatus;
  if (counts.pending + counts.processing + counts.awaiting_retry > 0) status = 'in_progress';
  else if (counts.needs_review > 0) status = 'needs_attention';
  else if (counts.failed > 0) status = 'completed_with_failures';
  else status = 'completed';

  const fxQuotes = ctx.db
    .prepare(
      `SELECT from_currency, to_currency, rate, source, target_total_minor, funding_minor, locked_at
         FROM fx_quotes WHERE payroll_run_id = ? ORDER BY to_currency`,
    )
    .all(runId);

  return { runId, status, counts, fxQuotes };
}
