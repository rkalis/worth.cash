import { getOpenSeaChainSlug } from 'lib/chains/opensea';
import { db } from 'lib/db';
import { nftCollectionKey } from 'lib/db/keys';
import type { StoredNftCollection } from 'lib/db/schema';
import { fetchCoinGeckoNftCollection } from 'lib/nfts/coingecko';
import { fetchOpenSeaCollection } from 'lib/nfts/opensea';
import { getApiKey } from 'lib/settings/runtime';
import { HOUR, WEEK } from 'lib/utils/time';
import type { Address } from 'viem';

// Floor prices move slowly enough that hourly is ample, and refreshing one costs at least a request.
const FLOOR_PRICE_MAX_AGE = 1 * HOUR;

// How long a "CoinGecko does not index this collection" answer is trusted for.
//
// Most collections in a real wallet are not in CoinGecko's index, and re-asking about every one of them on
// every hourly floor refresh would spend the whole rate limit learning the same 404s. The answer only
// changes when CoinGecko adds a collection, which happens on the scale of weeks, not hours.
const COINGECKO_LOOKUP_MAX_AGE = 1 * WEEK;

// Fetches floor prices for the given collections and stores them in USD.
//
// Two sources, tried in order, because neither alone is sufficient:
//
//   - CoinGecko first. It is one request keyed directly by contract address, it returns USD without us
//     having to convert from whatever currency the floor is quoted in, it needs no key beyond the one token
//     pricing already uses, and it covers chains that have no OpenSea marketplace at all (Berachain,
//     HyperEVM, Robinhood, and others). Its limitation is breadth: it indexes roughly two thousand
//     collections, so anything outside the blue chips is simply absent.
//   - OpenSea second, for exactly that long tail, which is most of a typical wallet.
//
// A collection neither source knows about still records the attempt, so an unlisted collection is not
// retried on every single refresh.
export const syncFloorPrices = async (chainId: number, collections: Address[]): Promise<number> => {
  if (collections.length === 0) return 0;

  const stored = await db.nftCollections.bulkGet(
    collections.map((collection) => nftCollectionKey(chainId, collection)),
  );
  const staleThreshold = Date.now() - FLOOR_PRICE_MAX_AGE;

  const staleCollections = collections.filter((_collection, index) => {
    const existing = stored[index];
    return !existing?.floorPriceUpdatedAt || existing.floorPriceUpdatedAt < staleThreshold;
  });

  if (staleCollections.length === 0) return 0;

  const openSeaApiKey = getApiKey('opensea');
  const hasOpenSeaCoverage = Boolean(openSeaApiKey) && Boolean(getOpenSeaChainSlug(chainId));

  let updatedCount = 0;

  for (const collection of staleCollections) {
    const updated = await syncCollectionFloorPrice(
      chainId,
      collection,
      hasOpenSeaCoverage ? openSeaApiKey : undefined,
    ).catch(() => false);

    if (updated) updatedCount += 1;
  }

  return updatedCount;
};

const syncCollectionFloorPrice = async (
  chainId: number,
  collection: Address,
  openSeaApiKey: string | undefined,
): Promise<boolean> => {
  const id = nftCollectionKey(chainId, collection);
  const existing = await db.nftCollections.get(id);

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
      floorPriceSource: 'coingecko' as const,
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

  // CoinGecko does not know this collection, so fall through to OpenSea's much wider index.
  if (!openSeaApiKey) {
    await db.nftCollections.update(id, update);
    return false;
  }

  const openSeaCollection = await fetchOpenSeaCollection(
    chainId,
    collection,
    openSeaApiKey,
    existing?.openseaSlug,
    !existing?.imageUrl,
  );

  if (!openSeaCollection) {
    await db.nftCollections.update(id, update);
    return false;
  }

  Object.assign(update, {
    openseaSlug: openSeaCollection.openseaSlug,
    floorPrice: openSeaCollection.floorPrice,
    floorPriceCurrency: openSeaCollection.floorPriceCurrency,
    floorPriceUsd: openSeaCollection.floorPriceUsd,
    floorPriceSource: 'opensea' as const,
    ...(openSeaCollection.imageUrl && !existing?.imageUrl ? { imageUrl: openSeaCollection.imageUrl } : {}),
    ...(openSeaCollection.name && !existing?.name ? { name: openSeaCollection.name } : {}),
  });

  await db.nftCollections.update(id, update);

  return openSeaCollection.floorPrice !== undefined;
};
