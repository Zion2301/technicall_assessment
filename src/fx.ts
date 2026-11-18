import type { Currency } from './money';

/**
 * Where FX quotes come from. In production this would be a treasury/FX
 * partner API returning a firm, time-limited quote we can execute against.
 */
export interface FxRateSource {
  quote(from: Currency, to: Currency): Promise<{ rate: string; source: string }>;
}

/** Fixed rates for tests and the demo. */
export class StaticFxRates implements FxRateSource {
  constructor(private readonly rates: Partial<Record<`${Currency}->${Currency}`, string>>) {}

  async quote(from: Currency, to: Currency) {
    if (from === to) return { rate: '1', source: 'identity' };
    const rate = this.rates[`${from}->${to}`];
    if (!rate) throw new Error(`No FX rate for ${from}->${to}`);
    return { rate, source: 'static-test-rates' };
  }
}
