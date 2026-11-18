import { ManualClock, seededRandom } from './clock';
import { type AppContext, type Config, DEFAULT_CONFIG } from './context';
import { openDb } from './db';
import { StaticFxRates } from './fx';
import { type ChaosOptions, MockProvider } from './providers/mockProvider';
import { ProviderRegistry } from './providers/registry';

/**
 * Wires the system up against mock providers: one per country, the way the
 * real thing would be wired with real adapters.
 */
export function createMockSystem(opts: { seed?: number; chaos?: ChaosOptions; config?: Partial<Config> } = {}) {
  const random = seededRandom(opts.seed ?? 42);
  const clock = new ManualClock();
  const ngn = new MockProvider({ name: 'paystack-mock', currencies: ['NGN'], random, chaos: opts.chaos });
  const kes = new MockProvider({ name: 'mpesa-mock', currencies: ['KES'], random, chaos: opts.chaos });
  const ghs = new MockProvider({ name: 'flutterwave-mock', currencies: ['GHS'], random, chaos: opts.chaos });

  const ctx: AppContext = {
    db: openDb(),
    clock,
    random,
    providers: new ProviderRegistry([ngn, kes, ghs]),
    fx: new StaticFxRates({ 'USD->NGN': '1550.25', 'USD->KES': '129.5', 'USD->GHS': '15.4' }),
    config: { ...DEFAULT_CONFIG, ...opts.config },
  };

  return { ctx, clock, mocks: { ngn, kes, ghs }, allMocks: [ngn, kes, ghs] };
}
