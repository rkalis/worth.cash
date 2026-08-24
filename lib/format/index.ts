import type { DisplayCurrency } from 'lib/fiat/rates';

// Formatting helpers shared by every table and card, so that the same number never renders two ways.

// How to render a value that is stored in USD. `rate` is how many units of `currency` one dollar buys, so a
// figure is converted exactly once, here, at the moment it becomes text.
//
// This is deliberately the only place conversion happens. Totals, shares and the dust thresholds are all
// computed in USD upstream; converting there instead would mean auditing every arithmetic site, and a
// threshold compared against a converted value would silently filter a different set of positions than the
// one the user configured.
export interface CurrencyDisplay {
  currency: DisplayCurrency;
  rate: number;
}

export const USD_DISPLAY: CurrencyDisplay = { currency: 'usd', rate: 1 };

const formatterCache = new Map<string, Intl.NumberFormat>();

const getFormatter = (currency: DisplayCurrency, options: Intl.NumberFormatOptions): Intl.NumberFormat => {
  const cacheKey = `${currency}:${JSON.stringify(options)}`;

  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;

  // The locale stays en-US whatever the currency, so that amounts, prices and totals keep one set of
  // separators. Mixing a euro's European grouping into a table of en-US token amounts reads as a bug.
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    ...options,
  });

  formatterCache.set(cacheKey, formatter);
  return formatter;
};

// The currency symbol the active formatter would use, for the few strings built by hand rather than
// formatted. Reading it from the formatter is what stops a hardcoded "$" leaking into euro output.
const getCurrencySymbol = (currency: DisplayCurrency): string =>
  getFormatter(currency, {})
    .formatToParts(0)
    .find((part) => part.type === 'currency')?.value ?? '';

const convert = (valueUsd: number, display: CurrencyDisplay): number => valueUsd * display.rate;

export const formatCurrency = (value: number | null | undefined, display: CurrencyDisplay = USD_DISPLAY): string => {
  if (value === null || value === undefined) return '-';

  const converted = convert(value, display);

  // Sub-cent values would all render as 0.00, which reads as "worthless" rather than "very small".
  if (converted > 0 && converted < 0.01) return `<${getCurrencySymbol(display.currency)}0.01`;

  return getFormatter(display.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(converted);
};

export const formatCompactCurrency = (
  value: number | null | undefined,
  display: CurrencyDisplay = USD_DISPLAY,
): string => {
  if (value === null || value === undefined) return '-';

  return getFormatter(display.currency, { notation: 'compact', maximumFractionDigits: 1 }).format(
    convert(value, display),
  );
};

export const formatTokenPrice = (value: number | null | undefined, display: CurrencyDisplay = USD_DISPLAY): string => {
  if (value === null || value === undefined) return '-';

  const converted = convert(value, display);
  if (converted === 0) return `${getCurrencySymbol(display.currency)}0`;

  // Prices below a cent need significant digits rather than a fixed decimal count. Formatted through Intl
  // rather than toPrecision, which flips to exponential below 1e-6 and would put "$5.00e-7" in a price
  // column; a memecoin priced that low is entirely ordinary.
  if (converted < 0.01) {
    return getFormatter(display.currency, { maximumSignificantDigits: 3, minimumFractionDigits: 0 }).format(converted);
  }

  return getFormatter(display.currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(converted);
};

// Token amounts span an enormous range, from fractions of a wei-denominated token to billions of a
// memecoin, so the precision adapts to the magnitude rather than being fixed.
export const formatAmount = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '-';
  if (value === 0) return '0';

  const absolute = Math.abs(value);

  if (absolute >= 1_000_000)
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
  if (absolute >= 1) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
  if (absolute >= 0.0001) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);

  return value.toExponential(2);
};

// A position's share of the portfolio total, for the column that sits beside its value.
//
// Shares under a tenth of a percent are shown as a bound rather than rounded to "0.0%", which would read as
// "none of it" for a position that is right there in the list. A share of zero means there is nothing to
// say - the position is unpriced, or it is one of the filtered rows that the total deliberately excludes -
// so it renders as nothing at all rather than as a misleading number.
export const formatShare = (share: number | null | undefined): string => {
  if (share === null || share === undefined || !Number.isFinite(share) || share <= 0) return '';
  if (share < 0.1) return '<0.1%';

  return `${share.toFixed(1)}%`;
};

export const formatPercentage = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

export const shortenAddress = (address: string, characters = 4): string => {
  if (address.length <= characters * 2 + 2) return address;
  return `${address.slice(0, characters + 2)}...${address.slice(-characters)}`;
};

export const formatDateShort = (timestamp: number): string => {
  // UTC rather than the viewer's zone: snapshot times are chosen and shown in UTC, and a date that
  // disagreed with the time printed beside it would be worse than either alone.
  return new Date(timestamp).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

// Snapshots are taken at a moment the user chose, so the time is part of what identifies them, and it is
// shown in UTC because that is what they were asked for.
export const formatDateTimeUtc = (timestamp: number): string => {
  const time = new Date(timestamp).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

  return `${formatDateShort(timestamp)}, ${time} UTC`;
};

export const formatRelativeTime = (timestamp: number): string => {
  const secondsAgo = Math.floor((Date.now() - timestamp) / 1000);

  if (secondsAgo < 60) return 'just now';
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  return `${Math.floor(secondsAgo / 86400)}d ago`;
};
