/**
 * Money handling.
 *
 * Rules enforced here:
 *  1. Amounts are always integers in the currency's minor unit (kobo, cents, pesewas).
 *     Floats are never used for money: 0.1 + 0.2 !== 0.3 in IEEE-754.
 *  2. An amount never travels without its currency (the `Money` type).
 *  3. FX rates are decimal *strings* and FX maths is done in BigInt, so
 *     `amount * rate` can neither lose precision nor overflow.
 */

export const CURRENCIES = {
  NGN: { minorUnitExponent: 2 }, // 1 naira  = 100 kobo
  KES: { minorUnitExponent: 2 }, // 1 shilling = 100 cents
  GHS: { minorUnitExponent: 2 }, // 1 cedi   = 100 pesewas
  USD: { minorUnitExponent: 2 }, // 1 dollar = 100 cents
} as const;

export type Currency = keyof typeof CURRENCIES;

export interface Money {
  amountMinor: number;
  currency: Currency;
}

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCIES, value);
}

/** Throws unless `n` is a whole, non-negative number that JS can represent exactly. */
export function assertMinorUnits(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid minor-unit amount: ${n} (must be a non-negative safe integer)`);
  }
}

export function money(amountMinor: number, currency: Currency): Money {
  assertMinorUnits(amountMinor);
  if (!isCurrency(currency)) throw new Error(`Unsupported currency: ${currency}`);
  return { amountMinor, currency };
}

/** Sums amounts, refusing to mix currencies. */
export function sumMoney(currency: Currency, items: Money[]): Money {
  let total = 0;
  for (const item of items) {
    if (item.currency !== currency) {
      throw new Error(`Currency mismatch: expected ${currency}, got ${item.currency}`);
    }
    total += item.amountMinor;
  }
  return money(total, currency); // re-validates: catches overflow past MAX_SAFE_INTEGER
}

/** For humans only (logs, audit output). Never parse this back. */
export function formatMoney(m: Money): string {
  const exp = CURRENCIES[m.currency].minorUnitExponent;
  const divisor = 10 ** exp;
  const major = Math.floor(m.amountMinor / divisor);
  const minor = String(m.amountMinor % divisor).padStart(exp, '0');
  return `${m.currency} ${major.toLocaleString('en-US')}.${minor}`;
}

// ---------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------

/**
 * A quoted rate: 1 unit of `from` buys `rate` units of `to`.
 * e.g. { from: 'USD', to: 'NGN', rate: '1550.25' }
 */
export interface FxRate {
  from: Currency;
  to: Currency;
  rate: string;
}

/** Parses "1550.25" into the exact fraction 155025 / 100. */
export function parseRate(rate: string): { numerator: bigint; denominator: bigint } {
  if (!/^\d+(\.\d+)?$/.test(rate)) throw new Error(`Invalid FX rate: "${rate}"`);
  const [whole, fraction = ''] = rate.split('.');
  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) throw new Error('FX rate must be greater than zero');
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b; // valid for non-negative a and positive b
}

/**
 * How much of the funding currency the company must provide so that we can
 * pay out exactly `target` in local currency.
 *
 * Note the direction: the employee's local-currency amount is fixed and is
 * never converted. FX only determines the company's funding cost.
 *
 * Rounds UP to the nearest funding minor unit: we may collect a fraction of
 * a cent too much, but we never end up short of what we owe employees.
 */
export function fundingRequired(target: Money, fx: FxRate): Money {
  if (fx.to !== target.currency) {
    throw new Error(`FX rate ${fx.from}->${fx.to} cannot fund ${target.currency}`);
  }
  const { numerator, denominator } = parseRate(fx.rate);
  const targetScale = 10n ** BigInt(CURRENCIES[fx.to].minorUnitExponent);
  const fundingScale = 10n ** BigInt(CURRENCIES[fx.from].minorUnitExponent);

  // fundingMinor = targetMinor / targetScale / rate * fundingScale
  //              = targetMinor * fundingScale * denominator / (targetScale * numerator)
  const result = ceilDiv(
    BigInt(target.amountMinor) * fundingScale * denominator,
    targetScale * numerator,
  );

  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Funding amount overflow');
  return money(Number(result), fx.from);
}
