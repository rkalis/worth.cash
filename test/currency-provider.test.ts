// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFiatRates = vi.fn();
const liveQueryResults = new Map<string, unknown>();

// Dexie opens a real IndexedDB connection on construction, which jsdom does not have. The provider only
// reaches the database through useLiveQuery, so both are stubbed.
vi.mock('lib/db', () => ({ db: { settings: { get: vi.fn() } } }));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => unknown) => {
    const source = String(querier);
    if (source.includes('app-settings')) return liveQueryResults.get('app-settings');
    return liveQueryResults.get('fiat-rates');
  },
}));

vi.mock('lib/fiat/rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lib/fiat/rates')>()),
  getFiatRates: () => getFiatRates(),
}));

const { CurrencyProvider, useCurrency } = await import('lib/hooks/useCurrency');

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    createElement(CurrencyProvider, null, children),
  );

const setStoredCurrency = (currency: string) =>
  liveQueryResults.set('app-settings', { key: 'app-settings', value: { display: { currency } } });

describe('CurrencyProvider', () => {
  beforeEach(() => {
    getFiatRates.mockReset();
    getFiatRates.mockResolvedValue({ rates: { USD: 1, EUR: 0.8 }, date: '2026-08-21', updatedAt: Date.now() });
    liveQueryResults.clear();
  });

  // The rates are not only a display concern: the same stored row is what values cash held on an exchange.
  // Gating the fetch on the display currency left a euro balance unpriced, and therefore hidden, for every
  // user on the default dollar display.
  it('fetches rates even when the display currency is dollars', async () => {
    setStoredCurrency('usd');

    renderHook(() => useCurrency(), { wrapper });

    await waitFor(() => expect(getFiatRates).toHaveBeenCalled());
  });

  it('fetches rates when the display currency is euro', async () => {
    setStoredCurrency('eur');

    renderHook(() => useCurrency(), { wrapper });

    await waitFor(() => expect(getFiatRates).toHaveBeenCalled());
  });

  it('converts through the stored rate once it is available', async () => {
    setStoredCurrency('eur');
    liveQueryResults.set('fiat-rates', { key: 'fiat-rates', value: { rates: { EUR: 0.8 }, date: '2026-08-21' } });

    const { result } = renderHook(() => useCurrency(), { wrapper });

    await waitFor(() => expect(result.current.isRateAvailable).toBe(true));
    expect(result.current.formatValue(100)).toBe('€80.00');
  });

  // Rendering every figure as NaN would be worse than showing dollars, so an absent rate falls back.
  it('falls back to dollars when no rate is stored', async () => {
    setStoredCurrency('eur');

    const { result } = renderHook(() => useCurrency(), { wrapper });

    expect(result.current.isRateAvailable).toBe(false);
    expect(result.current.formatValue(100)).toBe('$100.00');
    expect(result.current.requestedCurrency).toBe('eur');
  });
});
