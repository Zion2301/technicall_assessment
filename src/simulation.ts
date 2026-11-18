import { type Currency } from './money';
import { createPayrollRun, type CreatePayrollRunInput, getRunSummary } from './payrollService';
import { PayoutProcessor } from './processor';
import { type ChaosOptions, DEFAULT_CHAOS } from './providers/mockProvider';
import { checkInvariants } from './invariants';
import { createMockSystem } from './setup';
import { handleWebhook, type WebhookResult } from './webhooks';

const TICK_MS = 30_000;

/**
 * Runs a whole payroll against misbehaving providers until every payout is
 * finished: timeouts, lost and duplicated webhooks, events out of order,
 * transient and permanent failures. Then checks every invariant.
 */
export async function simulatePayroll(opts: { seed: number; employees: number; chaos?: ChaosOptions; maxTicks?: number }) {
  const sys = createMockSystem({ seed: opts.seed, chaos: opts.chaos ?? DEFAULT_CHAOS });
  const { ctx, clock, allMocks } = sys;

  const currencies: Currency[] = ['NGN', 'KES', 'GHS'];
  // Realistic monthly net pay ranges, in minor units.
  const ranges: Record<string, [number, number]> = {
    NGN: [150_000_00, 2_500_000_00],
    KES: [30_000_00, 400_000_00],
    GHS: [2_000_00, 30_000_00],
  };
  const items = Array.from({ length: opts.employees }, (_, i) => {
    const currency = currencies[i % currencies.length]!;
    const [lo, hi] = ranges[currency]!;
    return {
      employeeId: `emp_${String(i + 1).padStart(4, '0')}`,
      amountMinor: lo + Math.floor(ctx.random() * (hi - lo)),
      currency,
      recipient: { name: `Employee ${i + 1}`, accountNumber: String(1_000_000_000 + i) },
    };
  });
  const request: CreatePayrollRunInput = { companyId: 'co_acme', idempotencyKey: 'payroll-2026-01', fundingCurrency: 'USD', items };

  const { runId } = await createPayrollRun(ctx, request);
  const clientRetry = await createPayrollRun(ctx, request); // e.g. the client's HTTP call timed out and it retried

  const processor = new PayoutProcessor(ctx);
  const webhookResults: Partial<Record<WebhookResult, number>> = {};
  const maxTicks = opts.maxTicks ?? 1_000;
  let ticks = 0;

  while (ticks < maxTicks) {
    ticks++;
    await processor.tick();
    for (const mock of allMocks) {
      if (ctx.random() < 0.5) mock.settlePending(); // banks finish queued transfers at their own pace
      for (const payload of mock.drainWebhooks()) {
        const result = handleWebhook(ctx, mock.name, payload);
        webhookResults[result] = (webhookResults[result] ?? 0) + 1;
      }
    }
    const unfinished = ctx.db.prepare(`SELECT COUNT(*) FROM payouts WHERE status NOT IN ('succeeded', 'failed')`).pluck().get() as number;
    if (unfinished === 0) break;
    clock.advance(TICK_MS);
  }

  const transfers = allMocks.flatMap((m) => m.allTransfers());
  return {
    ...sys,
    runId,
    clientRetryReturnedSameRun: clientRetry.runId === runId && !clientRetry.created,
    ticks,
    simulatedMinutes: Math.round((ticks * TICK_MS) / 60_000),
    summary: getRunSummary(ctx, runId),
    webhookResults,
    providerCalls: allMocks.map((m) => ({ provider: m.name, sends: m.sendCalls, statusChecks: m.statusCalls })),
    violations: checkInvariants(ctx.db, transfers),
  };
}
