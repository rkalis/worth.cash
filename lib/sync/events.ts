import { db } from 'lib/db';
import { syncCursorKey, transferEventKey } from 'lib/db/keys';
import type { StoredTransferEvent } from 'lib/db/schema';
import { parseTransferLogs, type TransferEvent } from 'lib/events';
import { buildTransferFilters } from 'lib/events/filters';
import { getLogsProvider } from 'lib/events/providers';
import { deduplicateLogs } from 'lib/events/utils';
import { mapAsyncBounded } from 'lib/utils/promises';
import type { Address } from 'viem';

export interface EventSyncResult {
  chainId: number;
  owner: Address;
  syncedToBlock: number;
  newEventCount: number;
  // True when there was nothing to do because the cursor was already at the chain head.
  alreadyUpToDate: boolean;
}

// How many of the six transfer filters run at once. They all hit the same provider and therefore the same
// rate limiter, so this mostly controls queue depth rather than throughput; keeping it below six leaves room
// for other chains to interleave.
const FILTER_CONCURRENCY = 3;

// Fetches every transfer log that changed this address's balances on this chain, and records them.
//
// The sync is incremental and resumable: the cursor holds the last fully synced block, so an interrupted
// run costs at most the blocks it had not yet committed, and a routine refresh only asks for new blocks.
export const syncTransferEvents = async (chainId: number, owner: Address): Promise<EventSyncResult> => {
  const logsProvider = getLogsProvider(chainId);
  const cursorId = syncCursorKey(chainId, owner);
  const cursor = await db.syncCursors.get(cursorId);

  const fromBlock = cursor ? cursor.lastSyncedBlock + 1 : 0;

  // The head must come from the log source itself. Taking it from a node while reading logs from an explorer
  // would record blocks as synced that the explorer has not indexed yet, permanently losing those transfers.
  const latestBlock = await logsProvider.getLatestBlock();

  if (fromBlock > latestBlock) {
    return { chainId, owner, syncedToBlock: latestBlock, newEventCount: 0, alreadyUpToDate: true };
  }

  await db.syncCursors.put({
    id: cursorId,
    chainId,
    owner: owner.toLowerCase(),
    lastSyncedBlock: cursor?.lastSyncedBlock ?? -1,
    firstSyncedBlock: cursor?.firstSyncedBlock ?? fromBlock,
    lastSyncedAt: cursor?.lastSyncedAt ?? 0,
    status: 'syncing',
  });

  try {
    const filters = Object.values(buildTransferFilters(owner, fromBlock, latestBlock));
    const logsPerFilter = await mapAsyncBounded(filters, FILTER_CONCURRENCY, (filter) => logsProvider.getLogs(filter));

    // A self-transfer between two of your own wallets matches both the inbound and the outbound filter, so
    // the combined result has to be deduplicated on the log's on-chain position before it is parsed.
    const logs = deduplicateLogs(logsPerFilter.flat());
    const events = parseTransferLogs(logs, chainId);

    await storeTransferEvents(events, owner);

    await db.syncCursors.put({
      id: cursorId,
      chainId,
      owner: owner.toLowerCase(),
      lastSyncedBlock: latestBlock,
      firstSyncedBlock: cursor?.firstSyncedBlock ?? fromBlock,
      lastSyncedAt: Date.now(),
      status: 'idle',
    });

    return { chainId, owner, syncedToBlock: latestBlock, newEventCount: events.length, alreadyUpToDate: false };
  } catch (error) {
    // The cursor is deliberately left where it was. Advancing it on failure would skip the blocks we never
    // managed to read, and those transfers would never be picked up again.
    await db.syncCursors.put({
      id: cursorId,
      chainId,
      owner: owner.toLowerCase(),
      lastSyncedBlock: cursor?.lastSyncedBlock ?? -1,
      firstSyncedBlock: cursor?.firstSyncedBlock ?? fromBlock,
      lastSyncedAt: cursor?.lastSyncedAt ?? 0,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
};

const storeTransferEvents = async (events: TransferEvent[], owner: Address): Promise<void> => {
  if (events.length === 0) return;

  const rows: StoredTransferEvent[] = events.map((event) => ({
    id: transferEventKey(event.chainId, owner, event.time.transactionHash, event.time.logIndex),
    chainId: event.chainId,
    owner: owner.toLowerCase(),
    token: event.token.toLowerCase(),
    standard: event.standard,
    from: event.from.toLowerCase(),
    to: event.to.toLowerCase(),
    amount: event.amount.toString(),
    tokenId: event.tokenId?.toString(),
    blockNumber: event.time.blockNumber,
    transactionIndex: event.time.transactionIndex,
    logIndex: event.time.logIndex,
    transactionHash: event.time.transactionHash,
    timestamp: event.time.timestamp,
  }));

  // bulkPut rather than bulkAdd, so that re-syncing an overlapping range updates rows instead of throwing.
  await db.transferEvents.bulkPut(rows);
};

// Every distinct token this address has ever sent or received on this chain, which is the candidate set we
// then check real balances for. A token that was fully sold still appears here, and is resolved to a zero
// balance by the balance step rather than being guessed at from the events.
export const getCandidateTokens = async (
  chainId: number,
  owner: Address,
): Promise<Array<{ token: Address; standard: TransferEvent['standard'] }>> => {
  const events = await db.transferEvents.where('[chainId+owner]').equals([chainId, owner.toLowerCase()]).toArray();

  const standardsByToken = new Map<string, TransferEvent['standard']>();

  for (const event of events) {
    // A contract that emits both ERC20-shaped and ERC721-shaped Transfer events is malformed; treating the
    // NFT reading as authoritative avoids calling `balanceOf` on it as though it were fungible.
    const existingStandard = standardsByToken.get(event.token);
    if (existingStandard === 'erc721' || existingStandard === 'erc1155') continue;
    standardsByToken.set(event.token, event.standard);
  }

  return [...standardsByToken.entries()].map(([token, standard]) => ({ token: token as Address, standard }));
};
