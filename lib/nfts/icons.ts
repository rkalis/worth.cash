import { db } from 'lib/db';
import { nftCollectionKey } from 'lib/db/keys';
import type { StoredNftCollection } from 'lib/db/schema';
import { WEEK } from 'lib/utils/time';
import { lookupWhoisTokensForChain, type WhoisChainLookup } from 'lib/whois';
import type { Address } from 'viem';

// How long a whois answer about a collection is trusted. The same cadence as token logos: the dataset changes
// on the scale of weeks, and a collection it does not know is not worth asking about on every sync.
const COLLECTION_ICON_MAX_AGE = 4 * WEEK;

// Collection-level icons from the revoke.cash whois dataset.
//
// The dataset covers NFT collections as well as tokens, keyed the same way by contract address, so an icon
// costs one static file behind a CDN per collection, fetched once and rechecked monthly. Items' own artwork
// is deliberately not fetched: that meant a tokenURI read and a metadata document from an arbitrary host or
// IPFS gateway for every item held, which is what the old NFT view spent most of a sync on.
//
// Each source keeps its own field: this step owns whoisImageUrl, and the floor-price step keeps the image
// CoinGecko returns in coingeckoImageUrl. The aggregation shows the whois icon where there is one, since the
// dataset is curated and covers far more than CoinGecko's few thousand collections. Keeping the two apart
// means neither can mask the other: an icon the dataset later drops is cleared here, and CoinGecko's shows.
export const syncCollectionIcons = async (chainId: number, collections: Address[]): Promise<number> => {
  if (collections.length === 0) return 0;

  const stored = await db.nftCollections.bulkGet(
    collections.map((collection) => nftCollectionKey(chainId, collection)),
  );
  const staleThreshold = Date.now() - COLLECTION_ICON_MAX_AGE;

  // Rows are created by the collection metadata step that runs before this one, so a missing row is a
  // collection that step could not record, and there is nothing to attach an icon to yet.
  const dueCollections = stored.filter(
    (collection): collection is StoredNftCollection =>
      collection !== undefined &&
      (collection.whoisCheckedAt === undefined || collection.whoisCheckedAt < staleThreshold),
  );
  if (dueCollections.length === 0) return 0;

  const { found, answered } = await lookupWhoisTokensForChain(
    chainId,
    dueCollections.map((collection) => collection.address as Address),
  ).catch((): WhoisChainLookup => ({ found: new Map(), answered: new Set() }));

  // Only collections that got an answer are recorded as checked. One whose lookup failed is left alone, so
  // the next sync asks again instead of treating an outage as a month of confirmed absence.
  const answeredCollections = dueCollections.filter((collection) => answered.has(collection.address));
  if (answeredCollections.length === 0) return 0;

  const checkedAt = Date.now();

  // Partial updates rather than puts, so a floor price the pricing step writes in the meantime survives. An
  // undefined whoisImageUrl removes the field, which is how an icon the dataset has since dropped goes away.
  await db.nftCollections.bulkUpdate(
    answeredCollections.map((collection) => ({
      key: collection.id,
      changes: { whoisCheckedAt: checkedAt, whoisImageUrl: found.get(collection.address)?.logoUrl },
    })),
  );

  return answeredCollections.filter((collection) => found.get(collection.address)?.logoUrl).length;
};
