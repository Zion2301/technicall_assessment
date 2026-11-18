/**
 * npm run demo [seed]
 *
 * Runs a 60-person payroll across Nigeria, Kenya and Ghana against
 * deliberately unreliable mock providers, then shows the outcome, the
 * reconciliation checks and the full audit trail of the most eventful payout.
 */
import { formatPayoutHistory, payoutHistory } from './audit';
import { ACCOUNTS, accountBalance } from './ledger';
import { type Currency, formatMoney, money } from './money';
import { simulatePayroll } from './simulation';

const seed = Number(process.argv[2] ?? 7);
const r = await simulatePayroll({ seed, employees: 60 });
const { db } = r.ctx;

const heading = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

heading(`Payroll run ${r.runId}  (seed ${seed})`);
console.log(`  Finished in ${r.ticks} worker ticks (~${r.simulatedMinutes} simulated minutes)`);
console.log(`  Run status: ${r.summary.status}`);
console.log(`  Payouts:    ${Object.entries(r.summary.counts).filter(([, n]) => n > 0).map(([s, n]) => `${s}=${n}`).join('  ')}`);
console.log(`  Client retried the create request: ${r.clientRetryReturnedSameRun ? 'same run returned, nothing duplicated' : 'PROBLEM'}`);

heading('FX locked at run creation (company funds in USD)');
for (const q of r.summary.fxQuotes as any[]) {
  console.log(
    `  ${q.from_currency}->${q.to_currency} @ ${q.rate.padEnd(8)} ` +
      `${formatMoney(money(q.target_total_minor, q.to_currency)).padStart(20)} needs ${formatMoney(money(q.funding_minor, q.from_currency))}`,
  );
}

heading('What the providers put us through');
for (const p of r.providerCalls) console.log(`  ${p.provider.padEnd(17)} send calls=${p.sends}  status checks=${p.statusChecks}`);
console.log(`  Webhooks: ${Object.entries(r.webhookResults).map(([k, n]) => `${k}=${n}`).join('  ')}`);

heading('Ledger (per currency)');
for (const c of ['NGN', 'KES', 'GHS'] as Currency[]) {
  const fmt = (account: string) => formatMoney(money(accountBalance(db, account, c), c)).padStart(20);
  console.log(`  ${c}  paid_to_employees ${fmt(ACCOUNTS.paidToEmployees)}   refunds_due ${fmt(ACCOUNTS.refundsDue)}   in_flight ${fmt(ACCOUNTS.inFlight)}`);
}

heading('Reconciliation against provider records');
if (r.violations.length === 0) {
  console.log('  ✓ No double payments  ✓ Every amount exact  ✓ Statuses match providers  ✓ Ledger balanced');
} else {
  for (const v of r.violations) console.log(`  ✗ ${v}`);
  process.exitCode = 1;
}

// Best story: a payout that hit an unknown outcome (timeout) and was still paid exactly once.
const busiest = db
  .prepare(
    `SELECT e.payout_id FROM payout_events e JOIN payouts p ON p.id = e.payout_id
      GROUP BY e.payout_id
      ORDER BY MAX(e.reason LIKE 'Outcome unknown%') DESC, MAX(p.status = 'succeeded') DESC, COUNT(*) DESC, e.payout_id
      LIMIT 1`,
  )
  .pluck()
  .get() as string;
heading('"What happened to this employee\'s salary?"');
console.log(formatPayoutHistory(payoutHistory(db, busiest)));
console.log();
