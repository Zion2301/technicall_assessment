import type { DB } from './db';
import { type Currency, formatMoney, money } from './money';

/**
 * Answers "what happened to this employee's salary, and why?" from three
 * append-only or immutable sources: status events, provider attempts and
 * ledger movements.
 */
export function payoutHistory(db: DB, payoutId: string) {
  const payout = db.prepare(`SELECT * FROM payouts WHERE id = ?`).get(payoutId) as {
    id: string; payroll_run_id: string; employee_id: string; amount_minor: number; currency: Currency;
    provider: string; status: string; created_at: number; recipient_json: string;
  };
  const events = db
    .prepare(`SELECT from_status, to_status, actor, reason, created_at FROM payout_events WHERE payout_id = ? ORDER BY id`)
    .all(payoutId) as { from_status: string | null; to_status: string; actor: string; reason: string; created_at: number }[];
  const attempts = db
    .prepare(
      `SELECT attempt_number, provider_reference, status, failure_code, status_checks
         FROM payout_attempts WHERE payout_id = ? ORDER BY attempt_number`,
    )
    .all(payoutId) as { attempt_number: number; provider_reference: string; status: string; failure_code: string | null; status_checks: number }[];
  const ledger = db
    .prepare(`SELECT txn_id, account, amount_minor, created_at FROM ledger_entries WHERE payout_id = ? ORDER BY id`)
    .all(payoutId) as { txn_id: string; account: string; amount_minor: number; created_at: number }[];
  return { payout, events, attempts, ledger };
}

export function findPayoutId(db: DB, runId: string, employeeId: string): string | undefined {
  return db.prepare(`SELECT id FROM payouts WHERE payroll_run_id = ? AND employee_id = ?`).pluck().get(runId, employeeId) as
    | string
    | undefined;
}

export function formatPayoutHistory(h: ReturnType<typeof payoutHistory>): string {
  const { payout } = h;
  const t0 = payout.created_at;
  const elapsed = (t: number) => {
    const s = Math.round((t - t0) / 1000);
    return `+${String(Math.floor(s / 60)).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`;
  };
  const amount = (minor: number) => formatMoney(money(Math.abs(minor), payout.currency));
  const recipient = JSON.parse(payout.recipient_json) as { name: string; accountNumber: string };

  const lines = [
    `Payout ${payout.id}`,
    `  Employee:  ${payout.employee_id} (${recipient.name}, account ${recipient.accountNumber})`,
    `  Amount:    ${amount(payout.amount_minor)} via ${payout.provider}`,
    `  Status:    ${payout.status.toUpperCase()}`,
    '',
    '  Timeline',
    ...h.events.map((e) => {
      const change = e.from_status === e.to_status ? `(${e.to_status})`.padEnd(30) : `${e.from_status ?? '∅'} → ${e.to_status}`.padEnd(30);
      return `    ${elapsed(e.created_at)}  ${e.actor.padEnd(10)} ${change} ${e.reason}`;
    }),
    '',
    '  Provider attempts',
    ...h.attempts.map(
      (a) =>
        `    #${a.attempt_number}  ${a.provider_reference}  ${a.status}${a.failure_code ? ` (${a.failure_code})` : ''}` +
        (a.status_checks ? `  [${a.status_checks} inconclusive status checks]` : ''),
    ),
    '',
    '  Ledger',
  ];

  const byTxn = new Map<string, typeof h.ledger>();
  for (const e of h.ledger) byTxn.set(e.txn_id, [...(byTxn.get(e.txn_id) ?? []), e]);
  for (const [txn, entries] of byTxn) {
    const from = entries.find((e) => e.amount_minor < 0)!;
    const to = entries.find((e) => e.amount_minor > 0)!;
    lines.push(`    ${elapsed(from.created_at)}  ${txn.split(':')[0]!.padEnd(7)} ${amount(from.amount_minor)}  ${from.account} → ${to.account}`);
  }
  return lines.join('\n');
}
