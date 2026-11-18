import type { Currency } from '../money';
import type { PayoutProvider } from './types';

/**
 * Routes each currency to a provider. Deliberately simple: one provider per
 * currency. Production routing would add fallbacks (e.g. Flutterwave if
 * Paystack is down), per-company preferences and cost-based selection.
 */
export class ProviderRegistry {
  private readonly byNameMap = new Map<string, PayoutProvider>();

  constructor(providers: PayoutProvider[]) {
    for (const p of providers) this.byNameMap.set(p.name, p);
  }

  forCurrency(currency: Currency): PayoutProvider {
    for (const p of this.byNameMap.values()) {
      if (p.currencies.includes(currency)) return p;
    }
    throw new Error(`No payout provider configured for ${currency}`);
  }

  byName(name: string): PayoutProvider {
    const p = this.byNameMap.get(name);
    if (!p) throw new Error(`Unknown provider: ${name}`);
    return p;
  }
}
