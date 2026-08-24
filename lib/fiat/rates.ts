import { db } from 'lib/db';
import ky from 'lib/ky';
import { HOUR, SECOND } from 'lib/utils/time';

// Every currency the app can display a portfolio in. Prices are always stored in USD, so this is purely a
// presentation choice, applied at the last possible moment.
export const DISPLAY_CURRENCIES = ['usd', 'eur'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export const CURRENCY_LABELS: Record<DisplayCurrency, string> = {
  usd: 'US dollar (USD)',
  eur: 'Euro (EUR)',
};

// Fiat an exchange can report as a cash balance. Held cash is part of a portfolio, and without a rate it
// would show up as just another unpriced row and be filtered away as though it were a spam airdrop.
export const FIAT_ASSET_CODES = ['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'] as const;

// Rates are quoted per one US dollar: `rates.EUR = 0.86` means one dollar buys 0.86 euro.
export interface StoredFiatRates {
  rates: Record<string, number>;
  // The working day the rates belong to, straight from the API. Reference rates are published once per
  // working day, so this is a truer freshness signal than the time we happened to fetch them.
  date: string;
  updatedAt: number;
}

export const FIAT_RATES_SETTING_KEY = 'fiat-rates';

// Reference rates are published once per working day, so refreshing twice a day is already generous. The
// stored copy is used in the meantime, and a portfolio in euro is not wrong by any amount that matters if
// its rate is a few hours old.
const RATES_MAX_AGE = 12 * HOUR;
const REQUEST_TIMEOUT = 10 * SECOND;

// The European Central Bank's daily reference rates, via Frankfurter.
//
// Chosen because it is the only free rate source that a browser can call directly: it needs no key and
// sends `Access-Control-Allow-Origin: *`, where the ECB's own feed sends no CORS headers at all and would
// need a route handler standing in front of it. The rates are the ECB's either way.
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest';

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

// The stored rates, refreshed first if they are stale. Returns undefined only when there is nothing stored
// and the fetch failed, which the UI reads as "keep showing dollars".
export const getFiatRates = async (): Promise<StoredFiatRates | undefined> => {
  const stored = (await db.settings.get(FIAT_RATES_SETTING_KEY))?.value as StoredFiatRates | undefined;

  if (stored && Date.now() - stored.updatedAt < RATES_MAX_AGE) return stored;

  const fetched = await fetchFiatRates().catch(() => undefined);

  // A failed refresh keeps the rates we already had. A day-old euro rate is worth far more than no euro
  // rate: the alternative is every figure on the page silently reverting to dollars.
  if (!fetched) return stored;

  await db.settings.put({ key: FIAT_RATES_SETTING_KEY, value: fetched });
  return fetched;
};

const fetchFiatRates = async (): Promise<StoredFiatRates> => {
  const symbols = FIAT_ASSET_CODES.filter((code) => code !== 'USD');

  const response = await ky
    .get(FRANKFURTER_URL, {
      searchParams: { base: 'USD', symbols: symbols.join(',') },
      timeout: REQUEST_TIMEOUT,
    })
    .json<FrankfurterResponse>();

  // Asserted rather than assumed. Every figure in the app would be wrong by the size of an exchange rate if
  // the API ever changed its default base, and the failure would look like a market move rather than a bug.
  if (response.base !== 'USD') {
    throw new Error(`Expected USD-based rates, got ${response.base}`);
  }

  const rates: Record<string, number> = { USD: 1 };
  for (const [code, rate] of Object.entries(response.rates ?? {})) {
    if (Number.isFinite(rate) && rate > 0) rates[code.toUpperCase()] = rate;
  }

  return { rates, date: response.date, updatedAt: Date.now() };
};

// What one unit of a fiat currency is worth in USD, which is the direction a price is quoted in.
export const fiatPriceUsd = (code: string, rates: Record<string, number> | undefined): number | null => {
  if (code.toUpperCase() === 'USD') return 1;

  const rate = rates?.[code.toUpperCase()];
  if (!rate || !Number.isFinite(rate) || rate <= 0) return null;

  return 1 / rate;
};

export const isFiatAssetCode = (code: string): boolean =>
  (FIAT_ASSET_CODES as readonly string[]).includes(code.toUpperCase());
