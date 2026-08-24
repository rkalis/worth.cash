import { fiatPriceUsd, isFiatAssetCode } from 'lib/fiat/rates';
import {
  type CurrencyDisplay,
  formatAmount,
  formatCompactCurrency,
  formatCurrency,
  formatShare,
  formatTokenPrice,
  USD_DISPLAY,
} from 'lib/format';
import { describe, expect, it } from 'vitest';

const EUR: CurrencyDisplay = { currency: 'eur', rate: 0.8 };

describe('formatCurrency', () => {
  it('formats dollars by default', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('converts to the display currency exactly once', () => {
    expect(formatCurrency(100, EUR)).toBe('€80.00');
  });

  it('keeps one set of separators whatever the currency', () => {
    // A euro's European grouping in a table of en-US token amounts would read as a bug, so the locale is
    // fixed and only the symbol changes.
    expect(formatCurrency(1234.5, EUR)).toBe('€987.60');
  });

  it('renders nothing for an absent value rather than zero', () => {
    expect(formatCurrency(null)).toBe('-');
    expect(formatCurrency(undefined)).toBe('-');
  });

  // Sub-cent values would all render as 0.00, which reads as "worthless" rather than "very small".
  it('marks sub-cent values with the active currency symbol', () => {
    expect(formatCurrency(0.001)).toBe('<$0.01');
    expect(formatCurrency(0.001, EUR)).toBe('<€0.01');
  });

  it('converts before deciding a value is sub-cent', () => {
    // 0.012 dollars is above a cent; 0.0096 euro is not.
    expect(formatCurrency(0.012)).toBe('$0.01');
    expect(formatCurrency(0.012, EUR)).toBe('<€0.01');
  });
});

describe('formatTokenPrice', () => {
  it('gives sub-cent prices significant digits instead of a fixed scale', () => {
    expect(formatTokenPrice(0.000012345)).toBe('$0.0000123');
    expect(formatTokenPrice(0.000012345, EUR)).toBe('€0.00000988');
  });

  it('uses the currency symbol for a zero price', () => {
    expect(formatTokenPrice(0, EUR)).toBe('€0');
  });

  it('formats ordinary prices with two decimals', () => {
    expect(formatTokenPrice(3000, EUR)).toBe('€2,400.00');
  });
});

describe('formatCompactCurrency', () => {
  it('compacts large values for a chart axis', () => {
    expect(formatCompactCurrency(1_500_000)).toBe('$1.5M');
    expect(formatCompactCurrency(1_500_000, EUR)).toBe('€1.2M');
  });
});

describe('formatAmount', () => {
  // Token amounts are quantities, not money, so a currency setting must never touch them.
  it('is unaffected by the display currency', () => {
    expect(formatAmount(1234.5)).toBe('1,234.5');
  });
});

describe('USD_DISPLAY', () => {
  it('is the identity conversion', () => {
    expect(USD_DISPLAY.rate).toBe(1);
    expect(formatCurrency(42, USD_DISPLAY)).toBe(formatCurrency(42));
  });
});

describe('fiatPriceUsd', () => {
  it('prices a dollar at a dollar without needing a rate', () => {
    expect(fiatPriceUsd('USD', undefined)).toBe(1);
  });

  // Rates are quoted per dollar, so the price of one euro is the reciprocal. Getting this backwards would
  // misvalue cash by the square of the rate and still look plausible.
  it('inverts the per-dollar rate to price one unit of a currency', () => {
    expect(fiatPriceUsd('EUR', { EUR: 0.8 })).toBe(1.25);
  });

  it('is case insensitive', () => {
    expect(fiatPriceUsd('eur', { EUR: 0.8 })).toBe(1.25);
  });

  it('returns null rather than guessing when a rate is missing or nonsense', () => {
    expect(fiatPriceUsd('EUR', undefined)).toBeNull();
    expect(fiatPriceUsd('EUR', { EUR: 0 })).toBeNull();
    expect(fiatPriceUsd('EUR', { EUR: Number.NaN })).toBeNull();
  });
});

describe('isFiatAssetCode', () => {
  it('recognises cash tickers an exchange can report', () => {
    expect(isFiatAssetCode('USD')).toBe(true);
    expect(isFiatAssetCode('eur')).toBe(true);
    expect(isFiatAssetCode('GBP')).toBe(true);
  });

  it('does not claim crypto tickers', () => {
    expect(isFiatAssetCode('USDC')).toBe(false);
    expect(isFiatAssetCode('BTC')).toBe(false);
  });
});

describe('formatTokenPrice at extreme scales', () => {
  // toPrecision flips to exponential below 1e-6, which would put "$5.00e-7" in a price column. A memecoin
  // priced that low is entirely ordinary.
  it('never falls back to scientific notation', () => {
    expect(formatTokenPrice(0.0000005)).toBe('$0.0000005');
    expect(formatTokenPrice(0.000000001234)).not.toContain('e-');
  });

  it('keeps the currency symbol at those scales', () => {
    expect(formatTokenPrice(0.0000005, EUR)).toContain('€');
    expect(formatTokenPrice(0.0000005, EUR)).not.toContain('e-');
  });
});

describe('formatShare', () => {
  it('renders a share to one decimal place', () => {
    expect(formatShare(32.74)).toBe('32.7%');
    expect(formatShare(100)).toBe('100.0%');
  });

  // Rounding these to "0.0%" would read as "none of it" for a position sitting right there in the list.
  it('shows a bound rather than rounding a tiny share to zero', () => {
    expect(formatShare(0.04)).toBe('<0.1%');
    expect(formatShare(0.0001)).toBe('<0.1%');
  });

  // A share of zero means there is nothing to say: the position is unpriced, or it is one of the filtered
  // rows the total deliberately excludes. Printing "0.0%" there would be a claim, not a blank.
  it('renders nothing when there is no share to report', () => {
    expect(formatShare(0)).toBe('');
    expect(formatShare(null)).toBe('');
    expect(formatShare(undefined)).toBe('');
    expect(formatShare(Number.NaN)).toBe('');
  });
});
