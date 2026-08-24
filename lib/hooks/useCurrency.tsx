'use client';

import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import { type DisplayCurrency, FIAT_RATES_SETTING_KEY, getFiatRates, type StoredFiatRates } from 'lib/fiat/rates';
import { type CurrencyDisplay, formatCompactCurrency, formatCurrency, formatTokenPrice, USD_DISPLAY } from 'lib/format';
import { DEFAULT_SETTINGS } from 'lib/settings/types';
import { HOUR } from 'lib/utils/time';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

interface CurrencyContextValue {
  display: CurrencyDisplay;
  // What the user asked for, which is not always what is being shown: with no rate available the app falls
  // back to dollars rather than rendering every figure as NaN.
  requestedCurrency: DisplayCurrency;
  isRateAvailable: boolean;
  // Distinguishes "no rate yet" from "the fetch failed", so the UI does not report an error while loading.
  isRateLoading: boolean;
  ratesDate?: string;
  formatValue: (value: number | null | undefined) => string;
  formatCompactValue: (value: number | null | undefined) => string;
  formatPrice: (value: number | null | undefined) => string;
}

const CurrencyContext = createContext<CurrencyContextValue | undefined>(undefined);

// Holds the display currency and its exchange rate for the whole app.
//
// One provider rather than a hook per component: settings are a Dexie live query and the token table
// renders a row per position, so calling the hook per row would open a subscription per row. It also gives
// the formatters a stable identity that changes when the rate arrives, which is what makes recharts pick up
// a late rate instead of keeping its first formatter forever.
export const CurrencyProvider = ({ children }: { children: ReactNode }) => {
  const settingsRow = useLiveQuery(() => db.settings.get('app-settings'), []);
  const storedRates = useLiveQuery(() => db.settings.get(FIAT_RATES_SETTING_KEY), []);

  const requestedCurrency = ((settingsRow?.value as { display?: { currency?: DisplayCurrency } } | undefined)?.display
    ?.currency ?? DEFAULT_SETTINGS.display.currency) as DisplayCurrency;

  // Refreshes the stored rates when they go stale. The live query above is what actually feeds the UI, so
  // this only has to run; its result is never read directly.
  //
  // Deliberately not gated on the display currency. These rates are no longer only a display concern: they
  // are also what values cash held on an exchange, so skipping the fetch for a dollar-denominated portfolio
  // left a euro balance unpriced and then hidden, quietly missing from the total.
  const ratesQuery = useQuery({
    queryKey: ['fiat-rates'],
    queryFn: () => getFiatRates().then((rates) => rates ?? null),
    staleTime: 1 * HOUR,
  });

  const isRateLoading = ratesQuery.isPending || storedRates === undefined;

  const value = useMemo<CurrencyContextValue>(() => {
    const rates = storedRates?.value as StoredFiatRates | undefined;
    const rate = requestedCurrency === 'usd' ? 1 : rates?.rates?.[requestedCurrency.toUpperCase()];

    const isRateAvailable = Boolean(rate && Number.isFinite(rate) && rate > 0);
    const display: CurrencyDisplay = isRateAvailable
      ? { currency: requestedCurrency, rate: rate as number }
      : USD_DISPLAY;

    return {
      display,
      requestedCurrency,
      isRateAvailable,
      isRateLoading,
      ratesDate: rates?.date,
      formatValue: (value) => formatCurrency(value, display),
      formatCompactValue: (value) => formatCompactCurrency(value, display),
      formatPrice: (value) => formatTokenPrice(value, display),
    };
  }, [requestedCurrency, storedRates, isRateLoading]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
};

export const useCurrency = (): CurrencyContextValue => {
  const context = useContext(CurrencyContext);

  if (!context) {
    throw new Error('useCurrency must be used inside a CurrencyProvider');
  }

  return context;
};
