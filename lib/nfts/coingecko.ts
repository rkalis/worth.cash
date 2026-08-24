import { HTTPError } from 'ky';
import { coinGeckoRequest, resolveCoinGeckoPlan, toAbsoluteCoinGeckoImageUrl } from 'lib/prices/coingecko';
import type { HistoricalPriceSeries } from 'lib/prices/historical';
import { startOfUtcDay } from 'lib/prices/historical';
import { resolveAssetPlatformId } from 'lib/prices/platforms';
import { DAY } from 'lib/utils/time';
import type { Address } from 'viem';

interface NftCollectionResponse {
  id?: string;
  name?: string;
  symbol?: string;
  image?: { small?: string; small_2x?: string };
  native_currency_symbol?: string;
  floor_price?: { usd?: number | null; native_currency?: number | null };
}

interface NftMarketChartResponse {
  // Pairs of [millisecond timestamp, value].
  floor_price_usd?: Array<[number, number]>;
}

// The outcome of a lookup, as three distinct cases rather than "collection or nothing".
//
// The distinction matters because the caller caches a negative answer for a week to avoid re-asking about
// collections CoinGecko will never have. A rate-limited request looks exactly like an absent collection if
// both collapse to `undefined`, and caching that would silently suppress pricing for a real collection
// until the cache expired.
export type CoinGeckoNftLookup =
  | { status: 'found'; collection: CoinGeckoNftCollection }
  | { status: 'not-indexed' }
  | { status: 'unavailable' };

export interface CoinGeckoNftCollection {
  // CoinGecko's own collection id, needed for the historical floor endpoint.
  coingeckoNftId: string;
  name?: string;
  symbol?: string;
  imageUrl?: string;
  floorPriceUsd?: number;
  floorPriceNative?: number;
  nativeCurrencySymbol?: string;
}

// Looks up a collection by chain and contract address.
//
// This is a better primary source than OpenSea for the collections it has. It is one request rather than
// two (OpenSea needs a contract-to-slug lookup first), it reuses the CoinGecko key that token pricing
// already requires rather than needing a separate hard-to-obtain one, and crucially it returns the floor
// price already converted to USD, so we do not have to maintain a table mapping every possible quote
// currency to its own price feed.
//
// The catch is coverage: CoinGecko lists on the order of two thousand collections, which is the blue-chip
// end of the market. OpenSea indexes orders of magnitude more, which is why it remains the fallback rather
// than being replaced.
export const fetchCoinGeckoNftCollection = async (
  chainId: number,
  contractAddress: Address,
): Promise<CoinGeckoNftLookup> => {
  const assetPlatformId = await resolveAssetPlatformId(chainId);

  // A chain CoinGecko has no asset platform for will never have NFT data either, so this is a settled no.
  if (!assetPlatformId) return { status: 'not-indexed' };

  try {
    const response = await coinGeckoRequest<NftCollectionResponse>(
      `/nfts/${assetPlatformId}/contract/${contractAddress.toLowerCase()}`,
    );

    if (!response.id) return { status: 'not-indexed' };

    return {
      status: 'found',
      collection: {
        coingeckoNftId: response.id,
        name: response.name,
        symbol: response.symbol,
        imageUrl:
          toAbsoluteCoinGeckoImageUrl(response.image?.small_2x) ?? toAbsoluteCoinGeckoImageUrl(response.image?.small),
        floorPriceUsd: response.floor_price?.usd ?? undefined,
        floorPriceNative: response.floor_price?.native_currency ?? undefined,
        nativeCurrencySymbol: response.native_currency_symbol,
      },
    };
  } catch (error) {
    // Only a 404 means the collection genuinely is not in CoinGecko's index. Anything else, and rate
    // limiting is by far the most common, is a temporary condition that must not be remembered as absence.
    if (error instanceof HTTPError && error.response.status === 404) return { status: 'not-indexed' };
    return { status: 'unavailable' };
  }
};

// Historical floor prices for a collection, as a series the snapshot builder can read like any other price.
//
// This is the only way to value NFTs correctly at a past moment rather than applying today's floor to
// past holdings. It is a paid-plan endpoint, so on a free or demo key it returns an empty series and the
// caller falls back to the current floor.
export const fetchCoinGeckoNftFloorHistory = async (
  coingeckoNftId: string,
  priceKey: string,
  window: { from: number; to: number },
): Promise<HistoricalPriceSeries> => {
  const plan = await resolveCoinGeckoPlan();

  // Checked up front so a free-tier user does not spend their rate limit on a request that always 401s.
  if (plan.tier !== 'pro') return { priceKey, points: [] };

  // This endpoint takes a day count rather than a date range, unlike the token history endpoints.
  const days = Math.max(1, Math.ceil((window.to - window.from) / DAY));

  try {
    const response = await coinGeckoRequest<NftMarketChartResponse>(
      `/nfts/${encodeURIComponent(coingeckoNftId)}/market_chart`,
      { days: String(days) },
    );

    const pointsByDay = new Map<number, number>();
    for (const [timestamp, floorPriceUsd] of response.floor_price_usd ?? []) {
      if (!Number.isFinite(floorPriceUsd)) continue;
      // Several points can land on the same UTC day; the last one wins, matching the token price handling.
      pointsByDay.set(startOfUtcDay(timestamp), floorPriceUsd);
    }

    return {
      priceKey,
      points: [...pointsByDay.entries()]
        .map(([timestamp, priceUsd]) => ({ timestamp, priceUsd }))
        .sort((a, b) => a.timestamp - b.timestamp),
    };
  } catch {
    return { priceKey, points: [] };
  }
};
