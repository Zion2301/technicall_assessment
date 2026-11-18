/**
 * The payout state machine. This table is the single source of truth for
 * which status changes are legal. Anything not listed is rejected.
 *
 *   pending ──► processing ──► succeeded
 *                 │   ▲
 *                 │   └── awaiting_retry   (definite, retryable failure)
 *                 ├─────► failed           (non-retryable, or retries exhausted)
 *                 └─────► needs_review     (outcome can't be determined automatically)
 *   awaiting_retry ──► needs_review        (conflicting evidence: stop retrying)
 *   needs_review ──► succeeded | failed | awaiting_retry   (late evidence or an operator decision)
 */
export const PAYOUT_STATUSES = [
  'pending',
  'processing',
  'awaiting_retry',
  'succeeded',
  'failed',
  'needs_review',
] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const ALLOWED_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  pending: ['processing'],
  processing: ['succeeded', 'awaiting_retry', 'failed', 'needs_review'],
  awaiting_retry: ['processing', 'needs_review'],
  needs_review: ['succeeded', 'failed', 'awaiting_retry'],
  succeeded: [], // terminal: money has left. Reversals would be a new flow, not a status flip.
  failed: [], // terminal: funds released back to the company.
};

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PayoutStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: PayoutStatus,
    readonly to: PayoutStatus,
  ) {
    super(`Illegal payout transition: ${from} -> ${to}`);
  }
}

export function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// Attempts have a simpler lifecycle: they start open and close exactly once.
// ---------------------------------------------------------------------------

export type AttemptStatus = 'in_flight' | 'accepted' | 'unknown' | 'succeeded' | 'failed';

/**
 * in_flight: recorded *before* calling the provider (it may or may not have been sent)
 * accepted:  provider acknowledged it, final result comes later (webhook / status check)
 * unknown:   we called, but don't know if it landed (timeout, dropped connection)
 */
export function isAttemptOpen(status: AttemptStatus): boolean {
  return status === 'in_flight' || status === 'accepted' || status === 'unknown';
}
