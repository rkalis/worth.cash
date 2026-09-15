import { beforeEach, describe, expect, it, vi } from 'vitest';

const coinGeckoRequest = vi.fn();
const resolveCoinGeckoPlan = vi.fn();
const resolveAssetPlatformId = vi.fn();

// Only the two network-touching exports are stubbed. Spreading the real module keeps its pure helpers
// real, so adding one to it later cannot quietly turn every lookup here into 'unavailable'.
vi.mock('lib/prices/coingecko', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lib/prices/coingecko')>()),
  coinGeckoRequest: (...args: unknown[]) => coinGeckoRequest(...args),
  resolveCoinGeckoPlan: () => resolveCoinGeckoPlan(),
}));

vi.mock('lib/prices/platforms', () => ({
  resolveAssetPlatformId: (...args: unknown[]) => resolveAssetPlatformId(...args),
}));

const { HTTPError } = await import('ky');
const { fetchCoinGeckoNftCollection, fetchCoinGeckoNftFloorHistory } = await import('lib/nfts/coingecko');

const httpError = (status: number) =>
  new HTTPError(new Response(null, { status }), new Request('https://api.coingecko.com/'), {} as never);

const PUDGY = '0xBd3531dA5CF5857e7CfAA92426877b022e612cf8' as const;

describe('fetchCoinGeckoNftCollection', () => {
  beforeEach(() => {
    coinGeckoRequest.mockReset();
    resolveAssetPlatformId.mockReset();
    resolveAssetPlatformId.mockResolvedValue('ethereum');
  });

  it('reads the floor price straight from the USD field', async () => {
    coinGeckoRequest.mockResolvedValue({
      id: 'pudgy-penguins',
      name: 'Pudgy Penguins',
      symbol: 'PPG',
      native_currency_symbol: 'ETH',
      floor_price: { usd: 8875.26, native_currency: 3.74 },
    });

    const lookup = await fetchCoinGeckoNftCollection(1, PUDGY);

    expect(lookup.status).toBe('found');
    expect(lookup.status === 'found' && lookup.collection).toMatchObject({
      coingeckoNftId: 'pudgy-penguins',
      name: 'Pudgy Penguins',
      floorPriceUsd: 8875.26,
      floorPriceNative: 3.74,
      nativeCurrencySymbol: 'ETH',
    });
  });

  // The endpoint is keyed by contract address, lowercased, under the chain's asset platform id.
  it('addresses the collection by asset platform and lowercased contract', async () => {
    resolveAssetPlatformId.mockResolvedValue('abstract');
    coinGeckoRequest.mockResolvedValue({ id: 'some-collection', floor_price: { usd: 1.43 } });

    await fetchCoinGeckoNftCollection(2741, PUDGY);

    expect(coinGeckoRequest).toHaveBeenCalledWith(`/nfts/abstract/contract/${PUDGY.toLowerCase()}`);
  });

  it('gives up when the chain has no CoinGecko asset platform, without spending a request', async () => {
    resolveAssetPlatformId.mockResolvedValue(undefined);

    expect((await fetchCoinGeckoNftCollection(999999, PUDGY)).status).toBe('not-indexed');
    expect(coinGeckoRequest).not.toHaveBeenCalled();
  });

  // Most collections are not indexed by CoinGecko at all, which surfaces as a 404. That is a settled answer
  // the caller is allowed to remember.
  it('reports a 404 as a settled "not indexed"', async () => {
    coinGeckoRequest.mockRejectedValue(httpError(404));

    expect((await fetchCoinGeckoNftCollection(1, PUDGY)).status).toBe('not-indexed');
  });

  // The distinction that matters: a rate-limited lookup must never be cached as absence, or a transient 429
  // during a large sync would suppress that collection's price until the negative cache expired.
  it('reports a rate limit as unavailable rather than as not indexed', async () => {
    coinGeckoRequest.mockRejectedValue(httpError(429));

    expect((await fetchCoinGeckoNftCollection(1, PUDGY)).status).toBe('unavailable');
  });

  it('reports a server error as unavailable', async () => {
    coinGeckoRequest.mockRejectedValue(httpError(503));

    expect((await fetchCoinGeckoNftCollection(1, PUDGY)).status).toBe('unavailable');
  });

  it('reports a network failure as unavailable', async () => {
    coinGeckoRequest.mockRejectedValue(new TypeError('Failed to fetch'));

    expect((await fetchCoinGeckoNftCollection(1, PUDGY)).status).toBe('unavailable');
  });

  it('reports a response with no collection id as not indexed', async () => {
    coinGeckoRequest.mockResolvedValue({ floor_price: { usd: 10 } });

    expect((await fetchCoinGeckoNftCollection(1, PUDGY)).status).toBe('not-indexed');
  });
});

describe('fetchCoinGeckoNftFloorHistory', () => {
  beforeEach(() => {
    coinGeckoRequest.mockReset();
    resolveCoinGeckoPlan.mockReset();
  });

  // The historical NFT endpoint is PRO-only and answers a free key with a 401, so we must not spend rate
  // limit discovering that on every collection.
  it('does not call the paid endpoint on a free plan', async () => {
    resolveCoinGeckoPlan.mockResolvedValue({ tier: 'public' });

    const series = await fetchCoinGeckoNftFloorHistory('pudgy-penguins', 'key', { from: 0, to: 1 });

    expect(series.points).toEqual([]);
    expect(coinGeckoRequest).not.toHaveBeenCalled();
  });

  it('collapses the paid response to one point per UTC day, ascending', async () => {
    resolveCoinGeckoPlan.mockResolvedValue({ tier: 'pro' });

    const dayTwo = Date.UTC(2026, 0, 2);
    const dayOne = Date.UTC(2026, 0, 1);

    coinGeckoRequest.mockResolvedValue({
      floor_price_usd: [
        [dayTwo + 3_600_000, 22],
        [dayOne + 3_600_000, 10],
        // A later reading on the same day supersedes the earlier one.
        [dayOne + 7_200_000, 11],
      ],
    });

    const series = await fetchCoinGeckoNftFloorHistory('pudgy-penguins', 'key', { from: dayOne, to: dayTwo });

    expect(series.points).toEqual([
      { timestamp: dayOne, priceUsd: 11 },
      { timestamp: dayTwo, priceUsd: 22 },
    ]);
  });

  it('falls back to an empty series when the paid endpoint fails', async () => {
    resolveCoinGeckoPlan.mockResolvedValue({ tier: 'pro' });
    coinGeckoRequest.mockRejectedValue(new Error('boom'));

    expect((await fetchCoinGeckoNftFloorHistory('x', 'key', { from: 0, to: 1 })).points).toEqual([]);
  });
});
