import { db } from 'lib/db';
import { nftCollectionKey } from 'lib/db/keys';
import type { StoredNftCollection } from 'lib/db/schema';
import { fetchCoinGeckoNftCollection } from 'lib/nfts/coingecko';
import { mapAsyncBounded } from 'lib/utils/promises';
import { DAY, HOUR, WEEK } from 'lib/utils/time';
import type { Address } from 'viem';

// Floor prices move slowly enough that hourly is ample, and refreshing one costs at least a request.
const FLOOR_PRICE_MAX_AGE = 1 * HOUR;

// How long to leave a collection alone when it could not be priced.
//
// Most collections in a real wallet have no floor anywhere: CoinGecko indexes roughly two thousand, and
// anything outside them is simply absent. Re-asking about every one of them every hour is the bulk of what
// makes this the slowest part of a sync, and the answer almost never changes. A collection that does have
// a floor still refreshes hourly, because that is the number people actually watch.
const UNPRICEABLE_RETRY_AGE = 1 * DAY;

// How many collections to price at once. CoinGecko is rate limited behind its own queue, so this does not
// overrun it; what it buys is overlap between lookups instead of a serial crawl.
const FLOOR_PRICE_CONCURRENCY = 6;

// How long a "CoinGecko does not index this collection" answer is trusted for.
//
// Most collections in a real wallet are not in CoinGecko's index, and re-asking about every one of them on
// every hourly floor refresh would spend the whole rate limit learning the same 404s. The answer only
// changes when CoinGecko adds a collection, which happens on the scale of weeks, not hours.
const COINGECKO_LOOKUP_MAX_AGE = 1 * WEEK;

// Fetches floor prices for the given collections and stores them in USD.
//
// CoinGecko is the sole source: one request keyed directly by contract address, answered in USD, using the
// key token pricing already needs. Its limitation is breadth, roughly two thousand collections, so the
// long tail of a typical wallet simply has no floor. A collection it does not know still records the
// attempt, so an unlisted collection is not retried on every single refresh.
export const syncFloorPrices = async (chainId: number, collections: Address[]): Promise<number> => {
  if (collections.length === 0) return 0;

  const stored = await db.nftCollections.bulkGet(
    collections.map((collection) => nftCollectionKey(chainId, collection)),
  );
  const staleThreshold = Date.now() - FLOOR_PRICE_MAX_AGE;

  const unpriceableThreshold = Date.now() - UNPRICEABLE_RETRY_AGE;

  const staleCollections = collections.filter((_collection, index) => {
    const existing = stored[index];
    if (!existing?.floorPriceUpdatedAt) return true;

    // A collection nobody could price is asked about far less often than one with a floor to refresh.
    const threshold = existing.floorPriceUsd === undefined ? unpriceableThreshold : staleThreshold;
    return existing.floorPriceUpdatedAt < threshold;
  });

  if (staleCollections.length === 0) return 0;

  // The rows are already in hand from the bulkGet above, so each collection is spared another read.
  const storedByAddress = new Map(
    stored.filter((collection) => collection !== undefined).map((collection) => [collection.address, collection]),
  );

  const results = await mapAsyncBounded(staleCollections, FLOOR_PRICE_CONCURRENCY, (collection) =>
    syncCollectionFloorPrice(chainId, collection, storedByAddress.get(collection.toLowerCase())).catch(() => false),
  );

  return results.filter(Boolean).length;
};

const syncCollectionFloorPrice = async (
  chainId: number,
  collection: Address,
  existing: StoredNftCollection | undefined,
): Promise<boolean> => {
  const id = nftCollectionKey(chainId, collection);

  const update: Partial<StoredNftCollection> = { floorPriceUpdatedAt: Date.now() };

  // Skip the lookup entirely for a collection we recently confirmed CoinGecko does not have. Collections it
  // does have are always re-fetched, since that request is what returns the current floor.
  const isKnownAbsentFromCoinGecko =
    !existing?.coingeckoNftId &&
    existing?.coingeckoCheckedAt !== undefined &&
    Date.now() - existing.coingeckoCheckedAt < COINGECKO_LOOKUP_MAX_AGE;

  const lookup = isKnownAbsentFromCoinGecko
    ? ({ status: 'not-indexed' } as const)
    : await fetchCoinGeckoNftCollection(chainId, collection);

  // Only a definitive answer is remembered. A failed lookup leaves the timestamp untouched so the next
  // refresh asks again rather than treating a rate limit as a permanent absence.
  if (!isKnownAbsentFromCoinGecko && lookup.status !== 'unavailable') {
    update.coingeckoCheckedAt = Date.now();
  }

  if (lookup.status === 'found' && lookup.collection.floorPriceUsd !== undefined) {
    const found = lookup.collection;

    Object.assign(update, {
      coingeckoNftId: found.coingeckoNftId,
      floorPrice: found.floorPriceNative,
      floorPriceCurrency: found.nativeCurrencySymbol,
      floorPriceUsd: found.floorPriceUsd,
      ...(found.imageUrl && !existing?.imageUrl ? { imageUrl: found.imageUrl } : {}),
      ...(found.name && !existing?.name ? { name: found.name } : {}),
    });

    await db.nftCollections.update(id, update);
    return true;
  }

  // A collection CoinGecko knows but has no floor for still keeps its id, which is what the historical
  // floor endpoint is keyed by.
  if (lookup.status === 'found') {
    update.coingeckoNftId = lookup.collection.coingeckoNftId;
  }

  await db.nftCollections.update(id, update);
  return false;
};
