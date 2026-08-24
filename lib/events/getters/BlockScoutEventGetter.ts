import { getChainApiKey } from 'lib/chains';
import { EventDataSourceOutOfSyncError, LatestBlockUnavailableError } from 'lib/events/errors';
import { isNullish } from 'lib/utils';
import type { Hex } from 'viem';
import { EtherscanEventGetter, explorerRequest } from './EtherscanEventGetter';
import type { EventGetter } from './EventGetter';

interface LatestBlockResponse {
  status: string;
  message: string;
  result: Hex;
}

interface IndexingStatusResponse {
  finished_indexing: boolean;
  finished_indexing_blocks: boolean;
  indexed_blocks_ratio: number;
  indexed_internal_transactions_ratio: number;
}

// Blockscout instances below this ratio are still backfilling, and their logs would be missing history that
// we would then record as "synced". Refusing is better than silently under-reporting a balance.
const MINIMUM_INDEXED_RATIO = 0.95;

// Newer Blockscout instances expose an Etherscan-compatible API, but the block-number endpoint differs and
// they additionally publish an indexing status that is worth checking before trusting their logs.
export class BlockScoutEventGetter extends EtherscanEventGetter implements EventGetter {
  async getLatestBlock(chainId: number): Promise<number> {
    const searchParams = prepareGetLatestBlockQuery(getChainApiKey(chainId));

    const latestBlockPromise = explorerRequest<LatestBlockResponse>(chainId, { searchParams });
    const indexingStatusPromise = explorerRequest<IndexingStatusResponse>(chainId, {
      searchParams: {},
      path: '/v2/main-page/indexing-status',
    });

    const [latestBlock, indexingStatus] = await Promise.allSettled([latestBlockPromise, indexingStatusPromise]);

    // The rejection is rethrown rather than replaced, so an "API key required" reaches the user intact.
    if (latestBlock.status !== 'fulfilled') throw latestBlock.reason;

    // Instances that do not publish an indexing status are assumed to be synced.
    if (indexingStatus.status === 'fulfilled' && !isNullish(indexingStatus.value?.indexed_blocks_ratio)) {
      if (indexingStatus.value.indexed_blocks_ratio < MINIMUM_INDEXED_RATIO) {
        throw new EventDataSourceOutOfSyncError(chainId);
      }
    }

    const blockNumber = Number(latestBlock.value.result);
    if (!blockNumber) throw new LatestBlockUnavailableError(chainId, 'no block number returned');

    return blockNumber;
  }
}

const prepareGetLatestBlockQuery = (apiKey?: string): Record<string, string> => {
  const query: Record<string, string | undefined> = {
    module: 'block',
    action: 'eth_block_number',
    apikey: apiKey,
  };

  return Object.fromEntries(Object.entries(query).filter(([, value]) => !isNullish(value))) as Record<string, string>;
};
