import { getChainConfig } from 'lib/chains';
import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import { db } from 'lib/db';
import { coingeckoPriceKey, onChainPriceKey } from 'lib/db/keys';
import type { SnapshotPosition, StoredSnapshot, StoredToken, StoredTransferEvent } from 'lib/db/schema';
import { resolveBlockAtTimestamp } from 'lib/history/blocks';
import { type NativeBalanceSeries, readHistoricalNativeBalances } from 'lib/history/native-balances';
import { getWeeklySnapshotTimestamps } from 'lib/history/weeks';
import { fetchCoinGeckoNftFloorHistory } from 'lib/nfts/coingecko';
import { resolveCoinGeckoIdsForSymbols } from 'lib/prices/assets';
import {
  fetchHistoricalSeriesForCoin,
  fetchHistoricalSeriesForContract,
  type HistoricalPriceSeries,
  priceAt,
  resolveHistoryWindow,
} from 'lib/prices/historical';
import { deduplicateArray, groupBy } from 'lib/utils';
import { mapAsyncBounded } from 'lib/utils/promises';
import { YEAR } from 'lib/utils/time';
import { formatUnits, getAddress } from 'viem';

export interface BackfillResult {
  snapshotCount: number;
  from: number;
  to: number;
  // True when the CoinGecko plan's history limit cut the range short.
  truncatedByPlan: boolean;
  // Assets whose historical prices could not be retrieved, and which therefore contribute nothing.
  unpricedAssetCount: number;
  // Chains whose RPC could not serve historical state, so their native balance history is missing from the
  // chart. Reported rather than silently treated as zero, which would look like the holding was sold.
  chainsWithoutNativeHistory: number[];
  // Collections valued at today's floor because no historical floor was available for them. CoinGecko's
  // historical NFT endpoint is paid-only, and covers only collections it indexes at all.
  nftCollectionsAtCurrentFloor: number;
}

export interface BackfillProgress {
  phase: 'resolving-blocks' | 'reading-native-balances' | 'fetching-prices' | 'building-snapshots';
  completed: number;
  total: number;
}

const PRICE_FETCH_CONCURRENCY = 3;
const BLOCK_RESOLUTION_CONCURRENCY = 4;

// Rebuilds the weekly portfolio history from the transfer events and exchange ledger we already hold.
//
// Two things are worth knowing about the numbers this produces:
//
//   - Token balances are reconstructed by summing transfer events, unlike current balances which are read
//     from the chain. That is exact for ordinary ERC20s but approximate for rebasing or fee-on-transfer
//     tokens, whose balances change without a corresponding Transfer event.
//   - NFT quantities are historical, and so are their floors where CoinGecko will serve them. That endpoint
//     is PRO-only, so on a free or demo key the current floor stands in for every week. The UI labels this,
//     and the result reports how many collections it applied to.
export const backfillWeeklySnapshots = async (
  onProgress?: (progress: BackfillProgress) => void,
): Promise<BackfillResult> => {
  const events = await db.transferEvents.toArray();

  // A disabled exchange account is one the user has said is not part of their portfolio, so its history is
  // left out too. Without this the chart and the dashboard would disagree about the same money.
  const enabledAccounts = await db.exchangeAccounts.where('enabled').equals(1).toArray();
  const enabledAccountIds = new Set(enabledAccounts.map((account) => account.id));
  const ledgerEntries = (await db.exchangeLedger.toArray()).filter((entry) => enabledAccountIds.has(entry.accountId));

  const earliestTimestamp = findEarliestTimestamp(events, ledgerEntries);
  const window = await resolveHistoryWindow(earliestTimestamp);
  const weeks = getWeeklySnapshotTimestamps(window.from, window.to);

  if (weeks.length === 0) {
    return {
      snapshotCount: 0,
      from: window.from,
      to: window.to,
      truncatedByPlan: window.truncated,
      unpricedAssetCount: 0,
      chainsWithoutNativeHistory: [],
      nftCollectionsAtCurrentFloor: 0,
    };
  }

  const fungibleEvents = events.filter((event) => event.standard === 'erc20');

  // Every chain that has any history, mapped to the block current at each snapshot boundary.
  const chainIds = deduplicateArray(fungibleEvents.map((event) => event.chainId).map(String)).map(Number);
  const blocksByChain = await resolveSnapshotBlocks(chainIds, weeks, onProgress);

  const tokens = await db.tokens.toArray();
  const tokensById = new Map(tokens.map((token) => [token.id, token]));

  const balanceSeries = buildTokenBalanceSeries(fungibleEvents, weeks, blocksByChain, tokensById);
  const collectionNames = await getCollectionNames();

  // Native tokens never appear in the event history, because moving ETH emits no log. They have to be read
  // from historical chain state instead, which is why this is a separate step rather than another series.
  const wallets = await db.wallets.where('enabled').equals(1).toArray();
  const owners = wallets.map((wallet) => getAddress(wallet.address));
  const nativeBalances =
    owners.length > 0
      ? await readHistoricalNativeBalances(chainIds, owners, weeks, blocksByChain, (completed, total) =>
          onProgress?.({ phase: 'reading-native-balances', completed, total }),
        )
      : { series: [], chainsWithoutArchiveAccess: [] };

  for (const nativeSeries of nativeBalances.series) {
    mergeNativeBalanceSeries(balanceSeries, nativeSeries);
  }
  const nftSeries = buildNftPositionSeries(events, weeks, blocksByChain, collectionNames);
  const exchangeSeries = buildExchangeBalanceSeries(ledgerEntries, weeks);

  const priceSeriesByKey = await fetchPriceSeries(
    [...balanceSeries.keys()],
    [...exchangeSeries.keys()],
    tokensById,
    window,
    onProgress,
  );

  // Historical floors where the plan allows them, with the current floor as the fallback. This is the only
  // part of the chart that cannot always be historically correct, so which one was used is reported back.
  const nftFloorPrices = await getCurrentNftFloorPrices();
  const nftFloorHistory = await fetchNftFloorHistory([...nftSeries.keys()], window, onProgress);

  const snapshots: StoredSnapshot[] = weeks.map((weekTimestamp, weekIndex) => {
    const positions: SnapshotPosition[] = [];

    for (const [priceKey, series] of balanceSeries) {
      const amount = series.amounts[weekIndex];
      if (amount === 0) continue;

      const priceUsd = priceAt(priceSeriesByKey.get(priceKey) ?? { priceKey, points: [] }, weekTimestamp);
      positions.push({
        priceKey,
        symbol: series.symbol,
        amount,
        priceUsd,
        valueUsd: priceUsd === null ? 0 : amount * priceUsd,
        kind: 'token',
      });
    }

    for (const [collectionKey, series] of nftSeries) {
      const count = series.counts[weekIndex];
      if (count === 0) continue;

      // A historical floor is preferred; the current floor stands in only where no history was available.
      const historicalFloor = nftFloorHistory.get(collectionKey);
      const floorPriceUsd =
        (historicalFloor ? priceAt(historicalFloor, weekTimestamp) : null) ?? nftFloorPrices.get(collectionKey) ?? null;
      positions.push({
        priceKey: collectionKey,
        symbol: series.name,
        amount: count,
        priceUsd: floorPriceUsd,
        valueUsd: floorPriceUsd === null ? 0 : count * floorPriceUsd,
        kind: 'nft',
      });
    }

    for (const [priceKey, series] of exchangeSeries) {
      const amount = series.amounts[weekIndex];
      if (amount === 0) continue;

      const priceUsd = priceAt(priceSeriesByKey.get(priceKey) ?? { priceKey, points: [] }, weekTimestamp);
      positions.push({
        priceKey,
        symbol: series.symbol,
        amount,
        priceUsd,
        valueUsd: priceUsd === null ? 0 : amount * priceUsd,
        kind: 'exchange',
      });
    }

    return {
      timestamp: weekTimestamp,
      totalUsd: positions.reduce((total, position) => total + position.valueUsd, 0),
      createdAt: Date.now(),
      positions,
    };
  });

  await db.snapshots.bulkPut(snapshots);

  const unpricedAssetCount = [...balanceSeries.keys(), ...exchangeSeries.keys()].filter(
    (priceKey) => (priceSeriesByKey.get(priceKey)?.points.length ?? 0) === 0,
  ).length;

  return {
    snapshotCount: snapshots.length,
    from: window.from,
    to: window.to,
    truncatedByPlan: window.truncated,
    unpricedAssetCount,
    chainsWithoutNativeHistory: nativeBalances.chainsWithoutArchiveAccess,
    nftCollectionsAtCurrentFloor: [...nftSeries.keys()].filter(
      (collectionKey) => (nftFloorHistory.get(collectionKey)?.points.length ?? 0) === 0,
    ).length,
  };
};

const findEarliestTimestamp = (events: StoredTransferEvent[], ledgerEntries: Array<{ timestamp: number }>): number => {
  const timestamps = [
    ...events.map((event) => event.timestamp).filter((timestamp): timestamp is number => Boolean(timestamp)),
    ...ledgerEntries.map((entry) => entry.timestamp),
  ];

  // Not every log source supplies timestamps. When none did, a year of history is a reasonable default and
  // is also as far back as a free CoinGecko plan would allow anyway.
  if (timestamps.length === 0) return Date.now() - YEAR;

  return Math.min(...timestamps);
};

const resolveSnapshotBlocks = async (
  chainIds: number[],
  weeks: number[],
  onProgress?: (progress: BackfillProgress) => void,
): Promise<Map<number, number[]>> => {
  const blocksByChain = new Map<number, number[]>();
  let completed = 0;

  await mapAsyncBounded(chainIds, BLOCK_RESOLUTION_CONCURRENCY, async (chainId) => {
    const blocks = await mapAsyncBounded(weeks, 2, async (weekTimestamp) => {
      const blockNumber = await resolveBlockAtTimestamp(chainId, weekTimestamp).catch(() => undefined);
      // An unresolvable boundary is treated as "before this chain existed", which contributes nothing.
      return blockNumber ?? 0;
    });

    blocksByChain.set(chainId, blocks);
    completed += 1;
    onProgress?.({ phase: 'resolving-blocks', completed, total: chainIds.length });
  });

  return blocksByChain;
};

interface BalanceSeries {
  symbol: string;
  // One entry per snapshot week, in the same order as `weeks`.
  amounts: number[];
}

// Folds one chain's native balance history into the series for that coin.
//
// Summed rather than assigned, because every ETH rollup reports the same coin id: Base, Arbitrum and
// Ethereum all arrive as `ethereum`. Assigning would leave the chart showing whichever chain happened to be
// read last and silently understate every week of native history.
export const mergeNativeBalanceSeries = (
  balanceSeries: Map<string, BalanceSeries>,
  nativeSeries: Pick<NativeBalanceSeries, 'coingeckoId' | 'symbol' | 'amounts'>,
): void => {
  const key = coingeckoPriceKey(nativeSeries.coingeckoId);
  const existing = balanceSeries.get(key);

  if (!existing) {
    balanceSeries.set(key, { symbol: nativeSeries.symbol, amounts: [...nativeSeries.amounts] });
    return;
  }

  existing.amounts = existing.amounts.map((amount, index) => amount + (nativeSeries.amounts[index] ?? 0));
};

// Walks each token's events once in block order while advancing through the weeks, rather than re-scanning
// every event for every week. With hundreds of weeks and tens of thousands of events, the difference is
// between a fast rebuild and one that locks the tab.
const buildTokenBalanceSeries = (
  events: StoredTransferEvent[],
  weeks: number[],
  blocksByChain: Map<number, number[]>,
  tokensById: Map<string, StoredToken>,
): Map<string, BalanceSeries> => {
  const series = new Map<string, BalanceSeries>();
  const eventsByToken = groupBy(events, (event) => `${event.chainId}:${event.token}`);

  for (const [tokenId, tokenEvents] of eventsByToken) {
    const token = tokensById.get(tokenId);
    if (!token || token.decimals === undefined || token.isSpam === 1) continue;

    const chainBlocks = blocksByChain.get(tokenEvents[0].chainId);
    if (!chainBlocks) continue;

    const sorted = [...tokenEvents].sort((a, b) => a.blockNumber - b.blockNumber);

    const amounts: number[] = [];
    let runningBalance = 0n;
    let eventIndex = 0;

    for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
      const blockAtWeek = chainBlocks[weekIndex];

      while (eventIndex < sorted.length && sorted[eventIndex].blockNumber <= blockAtWeek) {
        const event = sorted[eventIndex];
        const amount = BigInt(event.amount);

        // A transfer to and from the same owner nets to zero, which falls out of applying both branches.
        if (event.to === event.owner) runningBalance += amount;
        if (event.from === event.owner) runningBalance -= amount;

        eventIndex += 1;
      }

      // A negative running balance means we are missing an inbound transfer, so zero is the safer reading.
      const clamped = runningBalance > 0n ? runningBalance : 0n;
      amounts.push(Number(formatUnits(clamped, token.decimals)));
    }

    const priceKey =
      token.address === NATIVE_TOKEN_ADDRESS.toLowerCase()
        ? coingeckoPriceKey(
            token.coingeckoId ?? getChainConfig(token.chainId as never)?.getNativeTokenCoingeckoId() ?? token.address,
          )
        : onChainPriceKey(token.chainId, token.address);

    series.set(priceKey, { symbol: token.symbol ?? 'Unknown', amounts });
  }

  return series;
};

interface NftSeries {
  name: string;
  counts: number[];
}

const buildNftPositionSeries = (
  events: StoredTransferEvent[],
  weeks: number[],
  blocksByChain: Map<number, number[]>,
  collectionNames: Map<string, string>,
): Map<string, NftSeries> => {
  const series = new Map<string, NftSeries>();
  const nftEvents = events.filter((event) => event.standard === 'erc721' || event.standard === 'erc1155');
  const eventsByCollection = groupBy(nftEvents, (event) => `${event.chainId}:${event.token}`);

  for (const [collectionKey, collectionEvents] of eventsByCollection) {
    const chainBlocks = blocksByChain.get(collectionEvents[0].chainId);
    if (!chainBlocks) continue;

    const sorted = [...collectionEvents].sort((a, b) => a.blockNumber - b.blockNumber);

    const counts: number[] = [];
    let runningCount = 0;
    let eventIndex = 0;

    for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
      const blockAtWeek = chainBlocks[weekIndex];

      while (eventIndex < sorted.length && sorted[eventIndex].blockNumber <= blockAtWeek) {
        const event = sorted[eventIndex];
        const quantity = Number(event.amount || '1');

        if (event.to === event.owner) runningCount += quantity;
        if (event.from === event.owner) runningCount -= quantity;

        eventIndex += 1;
      }

      counts.push(Math.max(0, runningCount));
    }

    // Falls back to the key only when we have never resolved a name for the collection, so a stored
    // snapshot reads as "Pudgy Penguins" rather than "2741:0x0c99...".
    series.set(collectionKey, { name: collectionNames.get(collectionKey) ?? collectionKey, counts });
  }

  return series;
};

const buildExchangeBalanceSeries = (
  ledgerEntries: Array<{ asset: string; amount: string; timestamp: number }>,
  weeks: number[],
): Map<string, BalanceSeries> => {
  const series = new Map<string, BalanceSeries>();
  const entriesByAsset = groupBy(ledgerEntries, (entry) => entry.asset);

  for (const [asset, assetEntries] of entriesByAsset) {
    const sorted = [...assetEntries].sort((a, b) => a.timestamp - b.timestamp);

    const amounts: number[] = [];
    let runningBalance = 0;
    let entryIndex = 0;

    for (const weekTimestamp of weeks) {
      while (entryIndex < sorted.length && sorted[entryIndex].timestamp <= weekTimestamp) {
        const amount = Number(sorted[entryIndex].amount);
        if (Number.isFinite(amount)) runningBalance += amount;
        entryIndex += 1;
      }

      amounts.push(Math.max(0, runningBalance));
    }

    // Keyed by asset for now; the CoinGecko id is substituted once resolved, in fetchPriceSeries.
    series.set(`exchange-asset:${asset}`, { symbol: asset, amounts });
  }

  return series;
};

const fetchPriceSeries = async (
  tokenPriceKeys: string[],
  exchangePriceKeys: string[],
  tokensById: Map<string, StoredToken>,
  window: Awaited<ReturnType<typeof resolveHistoryWindow>>,
  onProgress?: (progress: BackfillProgress) => void,
): Promise<Map<string, HistoricalPriceSeries>> => {
  const seriesByKey = new Map<string, HistoricalPriceSeries>();

  const exchangeSymbols = exchangePriceKeys.map((key) => key.replace('exchange-asset:', ''));
  const coingeckoIdsBySymbol = await resolveCoinGeckoIdsForSymbols(exchangeSymbols);

  const allKeys = [...tokenPriceKeys, ...exchangePriceKeys];
  let completed = 0;

  await mapAsyncBounded(allKeys, PRICE_FETCH_CONCURRENCY, async (priceKey) => {
    const series = await fetchSeriesForKey(priceKey, tokensById, coingeckoIdsBySymbol, window);
    seriesByKey.set(priceKey, series);

    completed += 1;
    onProgress?.({ phase: 'fetching-prices', completed, total: allKeys.length });
  });

  return seriesByKey;
};

const fetchSeriesForKey = async (
  priceKey: string,
  tokensById: Map<string, StoredToken>,
  coingeckoIdsBySymbol: Map<string, string>,
  window: Awaited<ReturnType<typeof resolveHistoryWindow>>,
): Promise<HistoricalPriceSeries> => {
  if (priceKey.startsWith('exchange-asset:')) {
    const symbol = priceKey.replace('exchange-asset:', '');
    const coingeckoId = coingeckoIdsBySymbol.get(symbol.toUpperCase());
    if (!coingeckoId) return { priceKey, points: [] };

    return fetchHistoricalSeriesForCoin(coingeckoId, priceKey, window);
  }

  if (priceKey.startsWith('coingecko:')) {
    return fetchHistoricalSeriesForCoin(priceKey.replace('coingecko:', ''), priceKey, window);
  }

  const [chainIdPart, address] = priceKey.split(':');
  const chainId = Number(chainIdPart);
  const token = tokensById.get(`${chainId}:${address}`);

  if (!token) return { priceKey, points: [] };

  return fetchHistoricalSeriesForContract(chainId, address, priceKey, window);
};

// Historical floor prices, one series per collection, for the collections CoinGecko has an id for.
//
// Collections with no id, and every collection when the key is not a paid one, come back empty and are
// valued at the current floor instead.
const fetchNftFloorHistory = async (
  collectionKeys: string[],
  window: Awaited<ReturnType<typeof resolveHistoryWindow>>,
  onProgress?: (progress: BackfillProgress) => void,
): Promise<Map<string, HistoricalPriceSeries>> => {
  const collections = await db.nftCollections.bulkGet(collectionKeys);
  const withCoingeckoId = collections.flatMap((collection) =>
    collection?.coingeckoNftId ? [{ key: collection.id, coingeckoNftId: collection.coingeckoNftId }] : [],
  );

  const historyByCollection = new Map<string, HistoricalPriceSeries>();
  if (withCoingeckoId.length === 0) return historyByCollection;

  let completed = 0;

  await mapAsyncBounded(withCoingeckoId, PRICE_FETCH_CONCURRENCY, async (collection) => {
    const series = await fetchCoinGeckoNftFloorHistory(collection.coingeckoNftId, collection.key, window);
    if (series.points.length > 0) historyByCollection.set(collection.key, series);

    completed += 1;
    onProgress?.({ phase: 'fetching-prices', completed, total: withCoingeckoId.length });
  });

  return historyByCollection;
};

const getCollectionNames = async (): Promise<Map<string, string>> => {
  const collections = await db.nftCollections.toArray();

  return new Map(
    collections
      .filter((collection) => Boolean(collection.name ?? collection.symbol))
      .map((collection) => [collection.id, (collection.name ?? collection.symbol) as string]),
  );
};

const getCurrentNftFloorPrices = async (): Promise<Map<string, number>> => {
  const collections = await db.nftCollections.toArray();

  return new Map(
    collections
      .filter((collection) => collection.floorPriceUsd !== undefined && collection.floorPriceUsd !== null)
      .map((collection) => [collection.id, collection.floorPriceUsd as number]),
  );
};
