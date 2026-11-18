# Reliable multi-country payroll payouts

A company employs people in Nigeria, Kenya and Ghana and must pay each of them in local currency (NGN, KES, GHS). This service takes a payroll run, pays every employee through a country-specific provider, and makes sure that **nobody is paid twice, nobody is paid the wrong amount, and every naira can be accounted for**. That has to hold even when providers time out, fail, or send webhooks twice and out of order.

The scope is deliberately narrow: the payment engine only, built to be correct. There's no UI, HTTP layer or auth (see [What I left out](#what-i-deliberately-left-out)).

```bash
npm install
npm test          # 60 tests, including a chaos simulation (~2s)
npm run demo      # full payroll against misbehaving providers, with an audit trail
```

Requires Node 20+. Uses SQLite in memory, so there's nothing to set up.

---

## The core problem

Moving money is easy. The hard part is **knowing whether money moved**. The dangerous moment is this one:

> We ask Paystack to send ₦250,000. The request times out. Did it go through?

If we assume it failed and retry, we may pay twice. If we assume it succeeded, the employee may not be paid. **Neither guess is acceptable**, and most of this design exists to avoid guessing:

1. **Record intent before acting.** The attempt row is committed *before* the provider is called.
2. **Use the same reference until we know.** Each attempt has a deterministic provider reference, used as our idempotency key towards the provider. A *new* reference (a real retry) is created only after the previous attempt is **confirmed** failed.
3. **Resolve unknowns by asking.** A reconciler queries the provider about that reference. It never resends blindly.

## Architecture

```
createPayrollRun ──► payouts (pending) ──► PayoutProcessor ──► PayoutProvider adapter ──► Paystack / M-Pesa / Flutterwave
   (client idempotency,                      │  claim + send              ▲                    (mocked)
    FX lock, ledger reserve)                 │  reconcile unknowns ───────┘
                                             ▼
                              applyAttemptOutcome  ◄── handleWebhook
                     (the one place results become state + ledger changes)
```

| File | Responsibility |
|---|---|
| `money.ts` | Integer minor units, currency always attached, exact BigInt FX maths |
| `db.ts` | Schema. Many guarantees are DB constraints, not just application code |
| `stateMachine.ts`, `transitions.ts` | Allowed transitions; compare-and-swap status changes with an audit event |
| `payrollService.ts` | Idempotent run creation, FX quote locking, ledger reservation |
| `processor.ts` | Claim → send → classify → retry with backoff; reconciler for unknown outcomes |
| `outcomes.ts` | Turns any provider result (response, status check, webhook) into state changes |
| `webhooks.ts` | Deduplicated, order-tolerant webhook handling |
| `providers/` | `PayoutProvider` interface, registry, chaos-capable mock |
| `ledger.ts`, `invariants.ts`, `audit.ts` | Double-entry ledger, reconciliation checks, "what happened to this salary" |

**Why SQLite + raw SQL (`better-sqlite3`):** the reviewer can run it with one command and nothing else installed. Each test gets a fresh in-memory database. Synchronous transactions make "state change + ledger entry + audit event" visibly atomic. Raw SQL keeps the correctness guarantees (UNIQUE constraints, `UPDATE ... WHERE status = ?`) in plain sight rather than hidden behind an ORM. **In production I'd use Postgres**: multiple concurrent writers and `SELECT ... FOR UPDATE SKIP LOCKED` for workers. The schema and the `ON CONFLICT` patterns carry over almost unchanged.

## Data model

```
payroll_runs     UNIQUE(company_id, idempotency_key) + request_hash
  ├─ fx_quotes   one locked rate per currency: rate (decimal string), source, totals, funding required
  └─ payouts     amount_minor + currency, provider, recipient snapshot, status
                 UNIQUE(payroll_run_id, employee_id)
       ├─ payout_attempts   one per provider call; provider_reference UNIQUE
       ├─ payout_events     append-only audit trail (who changed what, and why)
       └─ ledger_entries    append-only double-entry; UNIQUE(txn_id, account)
webhook_events   UNIQUE(provider, provider_event_id)
```

- **Money** is always an integer in minor units (kobo, cents, pesewas), stored with its currency. Floats are never used.
- **FX.** Salaries are fixed in the employee's local currency and **never converted**. FX determines only the company's *funding* cost. One quote per currency is locked at run creation and stored with the run, so a retry days later still uses the agreed rate. Funding is **rounded up**: the company may over-fund by a fraction of a cent, and we are never short.
- **Recipient snapshot.** Each payout keeps a copy of the bank details as they were when payroll was approved. A retry can't be redirected to an account that changed later, and the audit shows where the money actually went.
- **Append-only history.** SQLite triggers reject UPDATE and DELETE on `payout_events` and `ledger_entries`.
- **Run status is derived** from its payouts (`in_progress`, `needs_attention`, `completed`, `completed_with_failures`), never stored, so the two can't disagree.

## Payout state machine

```
pending ──► processing ──► succeeded                    (terminal)
               │   ▲
               │   └── awaiting_retry                   (confirmed failure, retryable, attempts left)
               ├─────► failed                           (non-retryable or retries exhausted; funds released)
               └─────► needs_review                     (can't resolve automatically, or providers contradict)
awaiting_retry ──► needs_review                         (conflicting evidence: stop retrying)
needs_review   ──► succeeded | failed | awaiting_retry  (late evidence or an operator decision)
```

Every status change goes through `transitionPayout()`. It checks the transition table and runs `UPDATE ... WHERE id = ? AND status = <expected>`. If the status has already moved (another worker, a webhook), zero rows change and the caller backs off. Each successful change writes an audit event in the same transaction.

The *attempt* is what can be `unknown`, not the payout. Attempts move from `in_flight` / `accepted` / `unknown` to `succeeded` / `failed`, exactly once.

## How failures and duplicates are handled

| Scenario | What happens | Proven by |
|---|---|---|
| Client submits the same payroll twice | Same idempotency key + same body returns the original run. Same key + different body → `IdempotencyConflictError`. `INSERT ... ON CONFLICT DO NOTHING` closes the race between concurrent identical requests. | `payrollRun.test.ts` |
| Same employee twice in a run | Rejected by validation, and by `UNIQUE(payroll_run_id, employee_id)` underneath | `payrollRun.test.ts`, `stateMachine.test.ts` |
| Two workers pick up the same payout | Compare-and-swap claim: one wins, the other skips | `retries.test.ts` |
| Retryable failure (provider down, rate limited) | New attempt with a **new** reference after exponential backoff with jitter (30s, 60s, 120s, capped), up to 4 attempts | `retries.test.ts` |
| Permanent failure (invalid account) | `failed` immediately, reserved funds released in the ledger | `retries.test.ts` |
| **Timeout after the money moved** | Attempt marked `unknown`. Not retried. The reconciler's status check finds it succeeded. One provider call in total. | `unknownOutcome.test.ts` |
| Timeout before the request arrived | Status check returns `not_found`, so we resend with the **same** reference. The provider deduplicates if the original turns up late. | `unknownOutcome.test.ts` |
| Crash after recording intent, before or after the provider call | The committed attempt row is found by the reconciler and resolved the same way | `unknownOutcome.test.ts` |
| Provider status API down for hours | After 5 inconclusive checks → `needs_review`. Polling continues, so it resolves itself when the provider recovers. | `unknownOutcome.test.ts` |
| Webhook delivered twice | Second insert hits `UNIQUE(provider, provider_event_id)` and is skipped | `webhooks.test.ts` |
| Same result via webhook *and* send response, in either order | The second arrival sees the attempt already closed with that result: no-op | `webhooks.test.ts` |
| Out-of-order webhook (`pending` after `succeeded`) | Ignored as stale. States never move backwards. | `webhooks.test.ts` |
| Contradiction (`succeeded` for an attempt we'd treated as failed) | Escalated to `needs_review`. The scheduled retry is **cancelled**. Never auto-resolved, because money may have moved twice. | `webhooks.test.ts` |
| Webhook lost | Accepted attempts go stale and are resolved by status polling | `unknownOutcome.test.ts` |

All provider results flow through one function, **`applyAttemptOutcome`**, so the send path, the reconciler and webhooks can't interpret the same news differently. It labels each piece of news `applied`, `duplicate`, `stale` or `conflict`.

### The chaos test

`chaos.test.ts` runs full 300-person payrolls on 5 random seeds against providers that time out (before *and* after moving money), fail temporarily and permanently, and drop, duplicate and reorder webhooks. When every payout has finished, `checkInvariants()` compares our records with the providers' own transfer records:

- no payout has more than one successful transfer
- every transfer amount and currency exactly matches what was owed
- no provider transfer exists without a matching attempt (orphan money)
- payout statuses agree with what the provider actually did
- every ledger transaction sums to zero, and ledger balances match payout statuses

The test proves it can fail: changing the timeout handler into a naive "retry with a new reference" makes the chaos test report `DOUBLE PAYMENT` on every seed.

## Auditability

`npm run demo` ends by printing the full history of one payout: every status change with who caused it and why, every provider attempt, and every ledger movement. For example:

```
+01m30s  processor  (processing)                Outcome unknown (ProviderTimeoutError); will check status with the provider, NOT resend blindly
+03m00s  webhook    processing → succeeded      Provider confirmed payment of KES 100,592.93
```

The same functions (`payoutHistory`, `formatPayoutHistory`) would back a support or ops screen.

## Trade-offs

- **The database is the work queue.** Due work is simply rows in `pending` or `awaiting_retry`. That avoids two sources of truth: there's no broker that can believe a job is pending when the DB says otherwise. A broker (SQS, or BullMQ, or pg-boss) would still be at-least-once delivery and need exactly this idempotency underneath. I'd add one for throughput and fan-out, not for correctness.
- **Sequential sends within a worker.** This keeps the code easy to read. Throughput comes from running more workers, which is safe because of the compare-and-swap claim. Production would add bounded concurrency per provider and per-provider rate limits.
- **Conservative classification.** Unknown failure codes are treated as permanent, and any exception during a send is treated as an unknown outcome. The cost is occasional human review instead of an automatic retry, which is the right trade for money.
- **One provider per currency.** The registry is the place where fallback routing would go (Flutterwave if Paystack is down). Fallback is only safe once the outcome on the first provider is *known*, which is why I left it out rather than doing it badly.
- **Minimal ledger.** Four accounts, not scoped per company. Enough to prove that money is conserved and settled exactly once. It's not a full chart of accounts.

## What I deliberately left out

- **HTTP API, auth, webhook signature verification.** The service functions are what an HTTP layer would call. `handleWebhook` marks where HMAC verification goes, and the handler should return 200 for every outcome, including duplicates.
- **Gross-to-net payroll** (PAYE, pension, NHF in Nigeria; SHIF and housing levy in Kenya; SSNIT in Ghana). That's an upstream calculation. This engine pays a given net amount reliably.
- **FX execution and treasury.** We lock and record the quote and compute funding. Actually buying the currency, and pre-funding provider balances, are separate flows.
- **Reversals and chargebacks** after a payout has succeeded. These would be a new flow with its own ledger entries, never a status flip.
- **Operator tooling** to resolve `needs_review` (the state machine already allows those transitions).
- **Real provider adapters.** The interface is designed around Paystack's, Flutterwave's and M-Pesa B2C's actual semantics: reference-based idempotency, async completion, status lookups.

## With more time / in production

1. **Postgres**, with `SELECT ... FOR UPDATE SKIP LOCKED` worker claims, and migrations.
2. **Real adapters** for Paystack (NG), M-Pesa B2C (KE), and Flutterwave or Paystack (GH), with recipient and bank verification (account name lookup) *before* the run is approved.
3. **Daily reconciliation against provider settlement reports and bank statements.** `checkInvariants` is the core of that job, fed with real reports instead of mock data.
4. **Approval workflow and maker-checker** before a run is released, plus funding checks against provider balances.
5. **Observability:** alerts on `needs_review`, conflicts and growing unknown-outcome counts. Per-provider success rates and latency. Circuit breakers so a down provider pauses sends instead of spending retries.
6. **Per-provider rate limiting and bounded concurrency**, and batching for 100k+ employee runs.
7. **Security:** encrypt recipient details at rest, restrict who can see them, and keep immutable audit retention for compliance.
# technicall_assessment
