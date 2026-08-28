import { ERC721_ABI, ERC1155_ABI } from 'lib/abis';
import { createViemPublicClientForChain, getChainConfig } from 'lib/chains';
import { db } from 'lib/db';
import type { StoredNftItem } from 'lib/db/schema';
import ky from 'lib/ky';
import { parseDataUriJson, resolveMediaUrl, substituteTokenId } from 'lib/nfts/media';
import { chunkArray } from 'lib/utils';
import { mapAsyncBounded } from 'lib/utils/promises';
import { type Address, getAddress } from 'viem';

interface TokenMetadataDocument {
  name?: string;
  image?: string;
  image_url?: string;
  imageUrl?: string;
}

const URI_BATCH_SIZE = 50;

// Metadata lives on arbitrary third-party hosts and IPFS gateways, both of which are frequently slow. This
// caps how many we wait on at once and how long any single one can hold up the batch.
const METADATA_FETCH_CONCURRENCY = 8;
// Must outlast the server's worst case, which walks three gateways at up to six seconds each. A shorter
// budget here made the browser abandon requests the server then completed a second later, so every
// document cost two full server round trips and still arrived as a failure.
const METADATA_FETCH_TIMEOUT = 20_000;

// Fetches artwork and names for NFTs we hold but have no metadata for yet.
//
// This is bounded per call rather than exhaustive: a wallet with thousands of NFTs would otherwise issue
// thousands of requests to IPFS gateways on every sync. The UI tops it up for whichever collection the user
// is actually looking at.
export const syncNftMetadata = async (chainId: number, owner: Address, limit = 100): Promise<number> => {
  const items = await db.nftItems.where('[chainId+owner]').equals([chainId, owner.toLowerCase()]).toArray();
  const itemsNeedingMetadata = items.filter((item) => !item.imageUrl && !item.name).slice(0, limit);

  return fetchMetadataForItems(chainId, itemsNeedingMetadata);
};

// Items already attempted this session, so a card re-rendering does not re-ask dead hosts about the same
// items forever. Session-scoped on purpose: an item whose metadata host was down yesterday deserves
// another try tomorrow, and nothing durable should record a transient failure as an answer.
const attemptedItemIds = new Set<string>();

// Fetches artwork for the items a collection card is actually showing.
//
// This is the other half of the bounded sync above: a sync tops up a hundred items per wallet per chain,
// which across a thousand collections leaves most artwork unfetched, and the card the user has scrolled to
// is exactly the place the missing hundred-and-first belongs. Bounded to what is on screen, deduplicated
// per session, and safe to call on every render.
export const topUpNftMetadata = async (chainId: number, items: StoredNftItem[]): Promise<number> => {
  const missing = items.filter((item) => !item.imageUrl && !attemptedItemIds.has(item.id));
  if (missing.length === 0) return 0;

  for (const item of missing) attemptedItemIds.add(item.id);

  return fetchMetadataForItems(chainId, missing);
};

const fetchMetadataForItems = async (chainId: number, itemsNeedingMetadata: StoredNftItem[]): Promise<number> => {
  if (itemsNeedingMetadata.length === 0) return 0;

  const uris = await readTokenUris(chainId, itemsNeedingMetadata);

  const documents = await mapAsyncBounded([...uris.entries()], METADATA_FETCH_CONCURRENCY, async ([itemId, uri]) => ({
    itemId,
    document: await fetchMetadataDocument(uri),
  }));

  const updates = documents.flatMap(({ itemId, document }) => {
    if (!document) return [];

    const imageUrl = resolveMediaUrl(document.image ?? document.image_url ?? document.imageUrl);
    const name = typeof document.name === 'string' ? document.name : undefined;

    if (!imageUrl && !name) return [];
    return [{ itemId, imageUrl, name }];
  });

  await db.transaction('rw', db.nftItems, async () => {
    for (const update of updates) {
      await db.nftItems.update(update.itemId, { imageUrl: update.imageUrl, name: update.name });
    }
  });

  return updates.length;
};

const readTokenUris = async (chainId: number, items: StoredNftItem[]): Promise<Map<string, string>> => {
  const client = createViemPublicClientForChain(chainId);
  const multicallAddress = getChainConfig(chainId).getDeployedContracts()?.multicall3?.address;
  const collectionStandards = await getCollectionStandards(chainId, items);

  const uris = new Map<string, string>();

  for (const batch of chunkArray(items, URI_BATCH_SIZE)) {
    const contracts = batch.map((item) => {
      const isErc1155 = collectionStandards.get(item.collection) === 'erc1155';

      return isErc1155
        ? {
            address: getAddress(item.collection),
            abi: ERC1155_ABI,
            functionName: 'uri' as const,
            args: [BigInt(item.tokenId)] as const,
          }
        : {
            address: getAddress(item.collection),
            abi: ERC721_ABI,
            functionName: 'tokenURI' as const,
            args: [BigInt(item.tokenId)] as const,
          };
    });

    const results = await client
      .multicall({ contracts: contracts as any, allowFailure: true, ...(multicallAddress ? { multicallAddress } : {}) })
      .catch(() => null);

    if (!results) continue;

    batch.forEach((item, index) => {
      const result = results[index];
      if (result?.status !== 'success' || typeof result.result !== 'string') return;

      const uri = substituteTokenId(result.result, item.tokenId);
      const resolved = uri.startsWith('data:') ? uri : resolveMediaUrl(uri);
      if (resolved) uris.set(item.id, resolved);
    });
  }

  return uris;
};

const getCollectionStandards = async (
  chainId: number,
  items: StoredNftItem[],
): Promise<Map<string, 'erc721' | 'erc1155'>> => {
  const collections = [...new Set(items.map((item) => item.collection))];
  const stored = await db.nftCollections.bulkGet(collections.map((collection) => `${chainId}:${collection}`));

  return new Map(collections.map((collection, index) => [collection, stored[index]?.standard ?? 'erc721']));
};

const fetchMetadataDocument = async (uri: string): Promise<TokenMetadataDocument | undefined> => {
  const inlineDocument = parseDataUriJson(uri);
  if (inlineDocument) return inlineDocument as TokenMetadataDocument;

  try {
    // Fetched through our own route rather than directly. Metadata hosts, including every public IPFS
    // gateway, generally send no CORS headers, so a direct fetch from the page is blocked by the browser.
    // Images are unaffected and load directly, since an <img> tag is not subject to CORS.
    return await ky
      .post('/api/nfts/metadata', { json: { url: uri }, timeout: METADATA_FETCH_TIMEOUT, retry: { limit: 1 } })
      .json<TokenMetadataDocument>();
  } catch {
    // A dead metadata host is entirely normal for older NFTs. The item still shows, just without artwork.
    return undefined;
  }
};
