import { ERC721_ABI, ERC1155_ABI } from 'lib/abis';
import { createViemPublicClientForChain, getChainConfig } from 'lib/chains';
import { db } from 'lib/db';
import { nftCollectionKey, nftItemKey } from 'lib/db/keys';
import type { StoredNftCollection, StoredNftItem, StoredTransferEvent } from 'lib/db/schema';
import { logSorterChronological } from 'lib/events/utils';
import { chunkArray, groupBy } from 'lib/utils';
import { WEEK } from 'lib/utils/time';
import { type Address, getAddress } from 'viem';

export interface NftSyncResult {
  chainId: number;
  owner: Address;
  heldItemCount: number;
  collectionCount: number;
}

const OWNERSHIP_BATCH_SIZE = 100;
const COLLECTION_METADATA_MAX_AGE = 4 * WEEK;

interface NftCandidate {
  collection: Address;
  tokenId: string;
  standard: 'erc721' | 'erc1155';
  amount: bigint;
}

// Works out which NFTs this address currently holds, from the transfer events we already have.
//
// The events are a complete record of everything that entered or left this address, so the holdings can be
// derived from them directly. We then verify each derived holding on-chain, because a single missed log,
// from a provider that briefly under-reported a range, would otherwise show as an NFT the user does not own.
export const syncNftBalances = async (chainId: number, owner: Address): Promise<NftSyncResult> => {
  const events = await db.transferEvents.where('[chainId+owner]').equals([chainId, owner.toLowerCase()]).toArray();
  const nftEvents = events.filter((event) => event.standard === 'erc721' || event.standard === 'erc1155');

  const candidates = deriveHeldNfts(nftEvents, owner);
  const verifiedCandidates = await verifyOwnership(chainId, owner, candidates);

  const updatedAt = Date.now();
  const rows: StoredNftItem[] = verifiedCandidates.map((candidate) => ({
    id: nftItemKey(chainId, owner, candidate.collection, candidate.tokenId),
    chainId,
    owner: owner.toLowerCase(),
    collection: candidate.collection.toLowerCase(),
    tokenId: candidate.tokenId,
    amount: candidate.amount.toString(),
    updatedAt,
  }));

  // Everything previously recorded for this owner and chain that is no longer held has to go, otherwise a
  // sold NFT would linger in the portfolio forever.
  const heldIds = new Set(rows.map((row) => row.id));
  const existingItems = await db.nftItems.where('[chainId+owner]').equals([chainId, owner.toLowerCase()]).toArray();
  const staleIds = existingItems.map((item) => item.id).filter((id) => !heldIds.has(id));

  await db.transaction('rw', db.nftItems, async () => {
    await db.nftItems.bulkDelete(staleIds);
    // Existing rows are merged rather than replaced, so that artwork and names fetched earlier survive.
    const merged = rows.map((row) => {
      const existing = existingItems.find((item) => item.id === row.id);
      return existing ? { ...row, name: existing.name, imageUrl: existing.imageUrl } : row;
    });
    await db.nftItems.bulkPut(merged);
  });

  const collections = [...new Set(verifiedCandidates.map((candidate) => candidate.collection.toLowerCase()))];
  await syncCollectionMetadata(chainId, collections as Address[], verifiedCandidates);

  return { chainId, owner, heldItemCount: rows.length, collectionCount: collections.length };
};

// ERC721 ownership is a matter of who received it last; ERC1155 ownership is a running total per token id.
export const deriveHeldNfts = (events: StoredTransferEvent[], owner: Address): NftCandidate[] => {
  const lowercaseOwner = owner.toLowerCase();
  const eventsByToken = groupBy(events, (event) => `${event.token}:${event.tokenId ?? ''}`);

  const candidates: NftCandidate[] = [];

  for (const [, tokenEvents] of eventsByToken) {
    const first = tokenEvents[0];
    if (!first?.tokenId) continue;

    if (first.standard === 'erc721') {
      const sorted = [...tokenEvents].sort(logSorterChronological);
      const lastEvent = sorted[sorted.length - 1];

      if (lastEvent.to === lowercaseOwner) {
        candidates.push({
          collection: first.token as Address,
          tokenId: first.tokenId,
          standard: 'erc721',
          amount: 1n,
        });
      }

      continue;
    }

    // ERC1155 balances are quantities, so inbound and outbound transfers net out against each other.
    const balance = tokenEvents.reduce((total, event) => {
      const amount = BigInt(event.amount);
      if (event.to === lowercaseOwner) return total + amount;
      if (event.from === lowercaseOwner) return total - amount;
      return total;
    }, 0n);

    if (balance > 0n) {
      candidates.push({
        collection: first.token as Address,
        tokenId: first.tokenId,
        standard: 'erc1155',
        amount: balance,
      });
    }
  }

  return candidates;
};

// Confirms each derived holding against the chain, and corrects ERC1155 quantities to their true value.
const verifyOwnership = async (
  chainId: number,
  owner: Address,
  candidates: NftCandidate[],
): Promise<NftCandidate[]> => {
  if (candidates.length === 0) return [];

  const client = createViemPublicClientForChain(chainId);
  const multicallAddress = getChainConfig(chainId).getDeployedContracts()?.multicall3?.address;
  const ownerAddress = getAddress(owner);

  const verified: NftCandidate[] = [];

  for (const batch of chunkArray(candidates, OWNERSHIP_BATCH_SIZE)) {
    const contracts = batch.map((candidate) =>
      candidate.standard === 'erc721'
        ? {
            address: getAddress(candidate.collection),
            abi: ERC721_ABI,
            functionName: 'ownerOf' as const,
            args: [BigInt(candidate.tokenId)] as const,
          }
        : {
            address: getAddress(candidate.collection),
            abi: ERC1155_ABI,
            functionName: 'balanceOf' as const,
            args: [ownerAddress, BigInt(candidate.tokenId)] as const,
          },
    );

    const results = await client
      .multicall({ contracts: contracts as any, allowFailure: true, ...(multicallAddress ? { multicallAddress } : {}) })
      .catch(() => null);

    // If verification itself failed we trust the derivation rather than dropping holdings we do have events
    // for. A missing multicall is a problem with the node, not evidence that the user sold the NFT.
    if (!results) {
      verified.push(...batch);
      continue;
    }

    batch.forEach((candidate, index) => {
      const result = results[index];

      if (result?.status !== 'success') {
        // A reverting `ownerOf` means the token was burned or never existed, so it is correctly dropped.
        return;
      }

      if (candidate.standard === 'erc721') {
        if ((result.result as string)?.toLowerCase() === owner.toLowerCase()) verified.push(candidate);
        return;
      }

      const balance = result.result as bigint;
      if (balance > 0n) verified.push({ ...candidate, amount: balance });
    });
  }

  return verified;
};

const syncCollectionMetadata = async (
  chainId: number,
  collections: Address[],
  candidates: NftCandidate[],
): Promise<void> => {
  if (collections.length === 0) return;

  const existingCollections = await db.nftCollections.bulkGet(
    collections.map((collection) => nftCollectionKey(chainId, collection)),
  );
  const staleThreshold = Date.now() - COLLECTION_METADATA_MAX_AGE;

  const collectionsToFetch = collections.filter((_collection, index) => {
    const existing = existingCollections[index];
    return !existing || existing.metadataUpdatedAt < staleThreshold;
  });

  if (collectionsToFetch.length === 0) return;

  const client = createViemPublicClientForChain(chainId);
  const multicallAddress = getChainConfig(chainId).getDeployedContracts()?.multicall3?.address;

  const rows: StoredNftCollection[] = [];

  for (const batch of chunkArray(collectionsToFetch, OWNERSHIP_BATCH_SIZE)) {
    const contracts = batch.flatMap((collection) => [
      { address: getAddress(collection), abi: ERC721_ABI, functionName: 'name' as const },
      { address: getAddress(collection), abi: ERC721_ABI, functionName: 'symbol' as const },
    ]);

    const results = await client
      .multicall({ contracts, allowFailure: true, ...(multicallAddress ? { multicallAddress } : {}) })
      .catch(() => null);

    batch.forEach((collection, index) => {
      const nameResult = results?.[index * 2];
      const symbolResult = results?.[index * 2 + 1];
      const standard =
        candidates.find((candidate) => candidate.collection.toLowerCase() === collection.toLowerCase())?.standard ??
        'erc721';

      rows.push({
        id: nftCollectionKey(chainId, collection),
        chainId,
        address: collection.toLowerCase(),
        standard,
        name: nameResult?.status === 'success' ? (nameResult.result as string) : undefined,
        symbol: symbolResult?.status === 'success' ? (symbolResult.result as string) : undefined,
        metadataUpdatedAt: Date.now(),
      });
    });
  }

  // Merge rather than overwrite: floor prices and artwork are written by other steps and must survive a
  // metadata refresh.
  const merged = await Promise.all(
    rows.map(async (row) => {
      const existing = await db.nftCollections.get(row.id);
      return existing ? { ...existing, ...row } : row;
    }),
  );

  await db.nftCollections.bulkPut(merged);
};
