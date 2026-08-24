import { getChainConfig } from 'lib/chains';
import { db } from 'lib/db';
import { coingeckoPriceKey, onChainPriceKey } from 'lib/db/keys';
import type { StoredPrice } from 'lib/db/schema';
import { coinGeckoRequest, parseCoinGeckoNumber } from 'lib/prices/coingecko';
import { chunkArray, deduplicateArray } from 'lib/utils';
import { MINUTE } from 'lib/utils/time';
import { type Address, getAddress } from 'viem';

interface OnChainPriceResponse {
  data: {
    attributes: {
      token_prices: Record<string, string>;
      total_reserve_in_usd?: Record<string, string>;
    };
  };
}

type SimplePriceResponse = Record<string, { usd?: number }>;

const COINGECKO_MAX_ADDRESSES_PER_REQUEST = 100;
const COINGECKO_MAX_IDS_PER_REQUEST = 250;

// Prices are considered fresh for this long. A portfolio does not need second-accurate pricing, and every
// avoided request is rate limit left over for the parts of a sync that cannot be cached.
const PRICE_MAX_AGE = 20 * MINUTE;

// A token quoted against a pool with less liquidity than this is not really priced: the number exists, but
// nothing could be sold at it. Filtering on it removes most worthless airdrop tokens that would otherwise
// show up with an inflated headline value.
const MIN_TOTAL_RESERVE_USD = 50_000;

// Fetches USD prices for on-chain tokens, keyed by contract address.
//
// Returns a map from price key to price, where `null` means CoinGecko has no reliable price for that token.
// A null is stored just like a real price, so that an unpriced token is not re-requested on every refresh.
export const fetchOnChainPrices = async (chainId: number, tokens: Address[]): Promise<Map<string, number | null>> => {
  const prices = new Map<string, number | null>();
  // Kept separate from `prices` so that only newly fetched entries are written back. Re-storing a cached
  // price would refresh its `updatedAt` and it would never be considered stale again.
  const fetchedPrices = new Map<string, number | null>();
  if (tokens.length === 0) return prices;

  const networkId = getChainConfig(chainId).getCoingeckoNetworkId();
  const uniqueTokens = deduplicateArray(tokens.map((token) => getAddress(token)));

  const { fresh, stale } = await partitionByFreshness(uniqueTokens.map((token) => onChainPriceKey(chainId, token)));
  for (const [key, price] of fresh) prices.set(key, price);

  // Chains without a CoinGecko network mapping simply have no priceable tokens; that is not an error.
  if (!networkId) {
    for (const key of stale) {
      prices.set(key, null);
      fetchedPrices.set(key, null);
    }
    await storePrices(fetchedPrices);
    return prices;
  }

  const staleTokens = uniqueTokens.filter((token) => stale.includes(onChainPriceKey(chainId, token)));

  for (const batch of chunkArray(staleTokens, COINGECKO_MAX_ADDRESSES_PER_REQUEST)) {
    const addressList = batch.join(',');

    try {
      const response = await coinGeckoRequest<OnChainPriceResponse>(
        `/onchain/simple/networks/${networkId}/token_price/${addressList}`,
        { include_total_reserve_in_usd: 'true' },
      );

      const tokenPrices = response.data?.attributes?.token_prices ?? {};
      const reserves = response.data?.attributes?.total_reserve_in_usd ?? {};

      for (const token of batch) {
        const price = parseCoinGeckoNumber(readByAddress(tokenPrices, token));
        const reserve = parseCoinGeckoNumber(readByAddress(reserves, token)) ?? 0;
        const isReliable = reserve >= MIN_TOTAL_RESERVE_USD;

        const key = onChainPriceKey(chainId, token);
        prices.set(key, isReliable ? price : null);
        fetchedPrices.set(key, isReliable ? price : null);
      }
    } catch {
      // A failed batch is deliberately left absent rather than written as a confirmed null, so the next
      // refresh retries it instead of treating a transient outage as "this token has no price".
    }
  }

  await storePrices(fetchedPrices);
  return prices;
};

// Fetches USD prices for assets identified by CoinGecko id: native tokens, and everything held on an
// exchange, where there is no contract address to price against.
export const fetchCoinGeckoIdPrices = async (coingeckoIds: string[]): Promise<Map<string, number | null>> => {
  const prices = new Map<string, number | null>();
  const fetchedPrices = new Map<string, number | null>();
  if (coingeckoIds.length === 0) return prices;

  const uniqueIds = deduplicateArray(coingeckoIds.map((id) => id.toLowerCase()));
  const { fresh, stale } = await partitionByFreshness(uniqueIds.map((id) => coingeckoPriceKey(id)));
  for (const [key, price] of fresh) prices.set(key, price);

  const staleIds = uniqueIds.filter((id) => stale.includes(coingeckoPriceKey(id)));

  for (const batch of chunkArray(staleIds, COINGECKO_MAX_IDS_PER_REQUEST)) {
    try {
      const response = await coinGeckoRequest<SimplePriceResponse>('/simple/price', {
        ids: batch.join(','),
        vs_currencies: 'usd',
        precision: 'full',
      });

      for (const id of batch) {
        const key = coingeckoPriceKey(id);
        const price = parseCoinGeckoNumber(response[id]?.usd) ?? null;
        prices.set(key, price);
        fetchedPrices.set(key, price);
      }
    } catch {
      // Same reasoning as above: a transient failure must not be recorded as a confirmed absence of price.
    }
  }

  await storePrices(fetchedPrices);
  return prices;
};

const partitionByFreshness = async (
  priceKeys: string[],
): Promise<{ fresh: Array<[string, number | null]>; stale: string[] }> => {
  const stored = await db.prices.bulkGet(priceKeys);
  const freshThreshold = Date.now() - PRICE_MAX_AGE;

  const fresh: Array<[string, number | null]> = [];
  const stale: string[] = [];

  priceKeys.forEach((key, index) => {
    const price = stored[index];
    if (price && price.updatedAt >= freshThreshold) {
      fresh.push([key, price.priceUsd]);
    } else {
      stale.push(key);
    }
  });

  return { fresh, stale };
};

const storePrices = async (prices: Map<string, number | null>): Promise<void> => {
  if (prices.size === 0) return;

  const updatedAt = Date.now();
  const rows: StoredPrice[] = [...prices.entries()].map(([id, priceUsd]) => ({ id, priceUsd, updatedAt }));

  await db.prices.bulkPut(rows);
};

// CoinGecko is inconsistent about whether it echoes addresses checksummed or lowercased, so we accept both.
const readByAddress = (values: Record<string, string>, address: Address): string | undefined => {
  return values[address] ?? values[address.toLowerCase()];
};
