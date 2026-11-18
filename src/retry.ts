import type { Random } from './clock';

export interface RetryPolicy {
  /** Total attempts including the first. Each attempt gets a new provider reference. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 30_000, // 30s, 60s, 120s ... capped
  maxDelayMs: 15 * 60_000,
};

/**
 * Exponential backoff with "equal jitter": the delay before retry n is
 * somewhere between 50% and 100% of base * 2^(n-1), capped.
 *
 * Why jitter: if a provider blips and 5,000 payouts fail at once, retrying
 * them all at exactly +30s would hammer it again in a synchronised wave.
 * Jitter spreads the retries out.
 */
export function backoffDelay(failedAttemptNumber: number, policy: RetryPolicy, random: Random): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failedAttemptNumber - 1));
  const half = exponential / 2;
  return Math.round(half + random() * half);
}
