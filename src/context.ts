import type { Clock, Random } from './clock';
import type { DB } from './db';
import type { FxRateSource } from './fx';
import type { ProviderRegistry } from './providers/registry';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry';

export interface Config {
  retry: RetryPolicy;
  /** How long an open attempt may sit before the reconciler asks the provider about it. */
  staleAttemptMs: number;
  /** Inconclusive status checks before we escalate a payout to needs_review. */
  maxStatusChecks: number;
  batchSize: number;
}

export const DEFAULT_CONFIG: Config = {
  retry: DEFAULT_RETRY_POLICY,
  staleAttemptMs: 60_000,
  maxStatusChecks: 5,
  batchSize: 100,
};

/** Everything the system depends on, passed explicitly (no globals, easy to fake in tests). */
export interface AppContext {
  db: DB;
  clock: Clock;
  random: Random;
  providers: ProviderRegistry;
  fx: FxRateSource;
  config: Config;
}
