import type { AppContext } from './context';
import { type ApplyResult, type AttemptOutcome, applyAttemptOutcome } from './outcomes';
import type { NormalizedWebhookEvent } from './providers/types';

export type WebhookResult = ApplyResult | 'duplicate_event' | 'unknown_reference';

/**
 * Handles one inbound provider webhook. Safe against:
 *
 *  - Exact duplicates (provider redelivers the same event): the
 *    UNIQUE(provider, provider_event_id) insert fails, so we stop there.
 *  - Same news under a different event id: applyAttemptOutcome sees the
 *    attempt is already closed with that result and returns 'duplicate'.
 *  - Out-of-order events ("pending" after "succeeded"): 'stale', ignored.
 *    The state machine never moves backwards.
 *  - Contradictions ("failed" after "succeeded"): 'conflict', escalated.
 *
 * The dedup insert and the state change share one transaction. If processing
 * throws, the dedup row rolls back too, so the provider's redelivery will be
 * processed properly instead of being wrongly skipped as a "duplicate".
 *
 * In an HTTP layer: verify the signature, call this, and return 200 for every
 * result (including duplicates). A non-2xx makes the provider keep retrying.
 */
export function handleWebhook(ctx: AppContext, providerName: string, payload: unknown): WebhookResult {
  const provider = ctx.providers.byName(providerName);
  const event = provider.parseWebhook(payload); // production: signature verification happens in here
  const { db } = ctx;

  return db.transaction((): WebhookResult => {
    const inserted = db
      .prepare(
        `INSERT INTO webhook_events (provider, provider_event_id, payload, outcome, received_at)
         VALUES (?, ?, ?, 'received', ?)
         ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      )
      .run(providerName, event.eventId, JSON.stringify(payload), ctx.clock.now());
    if (inserted.changes === 0) return 'duplicate_event';

    const attemptId = db
      .prepare(`SELECT id FROM payout_attempts WHERE provider = ? AND provider_reference = ?`)
      .pluck()
      .get(providerName, event.reference) as string | undefined;

    // Not ours, or for a reference we never created: keep it for investigation, change nothing.
    const result: WebhookResult = attemptId
      ? applyAttemptOutcome(ctx, attemptId, toOutcome(event), 'webhook', { webhookEventId: event.eventId })
      : 'unknown_reference';

    db.prepare(`UPDATE webhook_events SET outcome = ? WHERE provider = ? AND provider_event_id = ?`).run(result, providerName, event.eventId);
    return result;
  })();
}

function toOutcome(event: NormalizedWebhookEvent): AttemptOutcome {
  switch (event.status) {
    case 'pending':
      return { kind: 'accepted' };
    case 'succeeded':
      return { kind: 'succeeded' };
    case 'failed':
      // A failure webhook with no code is treated as permanent: a human looks, we don't retry blindly.
      return { kind: 'failed', code: event.failureCode ?? 'unspecified', retryable: event.retryable ?? false };
  }
}
