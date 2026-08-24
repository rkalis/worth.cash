import { createViemPublicClientForChain, getChainApiKey, getChainApiUrl, getChainConfig } from 'lib/chains';
import { SupportType } from 'lib/chains/Chain';
import { db } from 'lib/db';
import { blockMarkerKey } from 'lib/db/keys';
import { explorerRequest } from 'lib/events/getters/EtherscanEventGetter';
import { SECOND } from 'lib/utils/time';

interface BlockNumberResponse {
  status?: string;
  message?: string;
  result?: string;
}

interface ChainAnchors {
  latestBlock: number;
  latestTimestamp: number;
  averageBlockTimeMs: number;
}

const anchorsByChain = new Map<number, Promise<ChainAnchors | undefined>>();

// How far back to sample when measuring a chain's average block time. Large enough to average out short-term
// variation, small enough that the sampled block still exists on chains with short histories.
const ANCHOR_SAMPLE_DISTANCE = 500_000;

// Finds the block that was current at a given moment on a given chain.
//
// This is what makes historical reconstruction possible without per-event timestamps: rather than resolving
// a timestamp for every transfer, we resolve a block number for each of the ~52 snapshot boundaries a year
// and compare block numbers, which every log source reports reliably.
export const resolveBlockAtTimestamp = async (chainId: number, timestamp: number): Promise<number | undefined> => {
  const cacheKey = blockMarkerKey(chainId, timestamp);
  const cached = await db.blockMarkers.get(cacheKey);
  if (cached) return cached.blockNumber;

  const blockNumber =
    (await resolveViaExplorer(chainId, timestamp)) ?? (await estimateViaInterpolation(chainId, timestamp));

  if (blockNumber === undefined) return undefined;

  // Block markers are immutable: the block current at a past timestamp never changes, so this cache never
  // needs invalidating and makes repeat backfills free.
  await db.blockMarkers.put({ id: cacheKey, chainId, timestamp, blockNumber });

  return blockNumber;
};

// Etherscan-family explorers answer this exactly in a single request, which is both cheaper and more
// accurate than anything we can do from an RPC node.
const resolveViaExplorer = async (chainId: number, timestamp: number): Promise<number | undefined> => {
  const chain = getChainConfig(chainId as never);
  const supportsExplorer =
    chain?.type === SupportType.ETHERSCAN ||
    chain?.type === SupportType.BLOCKSCOUT ||
    chain?.type === SupportType.ROUTESCAN;

  if (!supportsExplorer) return undefined;

  const apiUrl = getChainApiUrl(chainId as never);
  if (!apiUrl) return undefined;

  try {
    const apiKey = getChainApiKey(chainId as never);

    const response = await explorerRequest<BlockNumberResponse>(chainId, {
      searchParams: {
        chainId: String(chainId),
        module: 'block',
        action: 'getblocknobytime',
        timestamp: String(Math.floor(timestamp / SECOND)),
        closest: 'before',
        ...(apiKey ? { apiKey } : {}),
      },
    });

    const blockNumber = Number(response.result);
    return Number.isFinite(blockNumber) && blockNumber > 0 ? blockNumber : undefined;
  } catch {
    // Falls back to interpolation, which is accurate enough for a snapshot boundary.
    return undefined;
  }
};

// Estimates the block from the chain's average block time.
//
// A snapshot does not need a block-exact boundary: being a few hundred blocks out shifts it by
// minutes, which cannot meaningfully change a week-over-week portfolio value. This is only used for chains
// whose explorer cannot answer the question directly.
const estimateViaInterpolation = async (chainId: number, timestamp: number): Promise<number | undefined> => {
  const anchors = await getChainAnchors(chainId);
  if (!anchors) return undefined;

  if (timestamp >= anchors.latestTimestamp) return anchors.latestBlock;

  const blocksBack = Math.floor((anchors.latestTimestamp - timestamp) / anchors.averageBlockTimeMs);
  const estimated = anchors.latestBlock - blocksBack;

  // Before the chain existed, every balance was zero, which block 0 correctly represents.
  return Math.max(0, estimated);
};

const getChainAnchors = async (chainId: number): Promise<ChainAnchors | undefined> => {
  const existing = anchorsByChain.get(chainId);
  if (existing) return existing;

  const anchors = measureChainAnchors(chainId);
  anchorsByChain.set(chainId, anchors);
  return anchors;
};

const measureChainAnchors = async (chainId: number): Promise<ChainAnchors | undefined> => {
  try {
    const client = createViemPublicClientForChain(chainId);

    const latest = await client.getBlock({ blockTag: 'latest' });
    const latestBlock = Number(latest.number);
    const latestTimestamp = Number(latest.timestamp) * SECOND;

    // On a very young chain there may be nothing far enough back to sample, so we fall back to block 1.
    const sampleBlockNumber = Math.max(1, latestBlock - ANCHOR_SAMPLE_DISTANCE);
    const sample = await client.getBlock({ blockNumber: BigInt(sampleBlockNumber) });
    const sampleTimestamp = Number(sample.timestamp) * SECOND;

    const blockDelta = latestBlock - sampleBlockNumber;
    const timeDelta = latestTimestamp - sampleTimestamp;

    if (blockDelta <= 0 || timeDelta <= 0) return undefined;

    return { latestBlock, latestTimestamp, averageBlockTimeMs: timeDelta / blockDelta };
  } catch {
    return undefined;
  }
};
