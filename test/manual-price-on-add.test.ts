// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCoinGeckoIdPrices = vi.fn();
const put = vi.fn();
const get = vi.fn();

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));

vi.mock('lib/db', () => ({
  db: {
    manualBalances: { toArray: async () => [], put: (row: unknown) => put(row), get: (id: string) => get(id) },
    manualLedger: { toArray: async () => [], put: vi.fn() },
  },
}));

vi.mock('lib/prices/current', () => ({
  fetchCoinGeckoIdPrices: (ids: string[]) => fetchCoinGeckoIdPrices(ids),
}));

const { useManualBalances } = await import('lib/hooks/useManualBalances');

describe('pricing a manual balance when it is added', () => {
  beforeEach(() => {
    fetchCoinGeckoIdPrices.mockReset();
    fetchCoinGeckoIdPrices.mockResolvedValue(new Map());
    put.mockReset();
    get.mockReset();
  });

  // Prices were otherwise only fetched during a sync, so a holding added between syncs sat unpriced - and an
  // unpriced holding is hidden by the spam filter, so it vanished from the portfolio rather than merely
  // lacking a number.
  it('fetches the price straight away instead of waiting for the next sync', async () => {
    const { result } = renderHook(() => useManualBalances());

    await result.current.addBalance({ symbol: 'SOL', location: 'Solana', coingeckoId: 'solana' });

    await waitFor(() => expect(fetchCoinGeckoIdPrices).toHaveBeenCalledWith(['solana']));
  });

  it('normalises the coin id before asking for it', async () => {
    const { result } = renderHook(() => useManualBalances());

    await result.current.addBalance({ symbol: 'SOL', location: 'Solana', coingeckoId: '  Solana  ' });

    await waitFor(() => expect(fetchCoinGeckoIdPrices).toHaveBeenCalledWith(['solana']));
  });

  it('asks for nothing when the holding has no price source', async () => {
    const { result } = renderHook(() => useManualBalances());

    await result.current.addBalance({ symbol: 'RARE', location: 'Cold storage' });

    expect(fetchCoinGeckoIdPrices).not.toHaveBeenCalled();
  });

  // Correcting a typo should show a price immediately rather than after the next sync.
  it('fetches again when the price source is corrected', async () => {
    get.mockResolvedValue({
      id: 'balance-1',
      symbol: 'SOL',
      location: 'Solana',
      coingeckoId: 'solanaa',
      createdAt: 0,
      enabled: 1,
    });

    const { result } = renderHook(() => useManualBalances());

    await result.current.updateBalance('balance-1', { coingeckoId: 'solana' });

    await waitFor(() => expect(fetchCoinGeckoIdPrices).toHaveBeenCalledWith(['solana']));
  });

  // Renaming the wallet is not a reason to spend a request.
  it('does not refetch when the price source is unchanged', async () => {
    get.mockResolvedValue({
      id: 'balance-1',
      symbol: 'SOL',
      location: 'Solana',
      coingeckoId: 'solana',
      createdAt: 0,
      enabled: 1,
    });

    const { result } = renderHook(() => useManualBalances());

    await result.current.updateBalance('balance-1', { wallet: 'Phantom' });

    expect(fetchCoinGeckoIdPrices).not.toHaveBeenCalled();
  });
});
