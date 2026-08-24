import { getChainConfig } from 'lib/chains';
import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import { db } from 'lib/db';
import { coingeckoPriceKey, onChainPriceKey } from 'lib/db/keys';
import type {
  SnapshotPosition,
  StoredManualBalance,
  StoredManualLedgerEntry,
  StoredSnapshot,
  StoredToken,
  StoredTransferEvent,
} from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';
import { resolveBlockAtTimestamp } from 'lib/history/blocks';
import { type NativeBalanceSeries, readHistoricalNativeBalances } from 'lib/history/native-balances';
import {
  createReconstructionProgress,
  type ReconstructionProgressListener,
  type ReconstructionProgressReporter,
} from 'lib/history/progress';
import { amountAt, groupEntriesByBalance } from 'lib/manual/balances';
import { fetchCoinGeckoNftFloorHistory } from 'lib/nfts/coingecko';
import { resolveCoinGeckoIdsForSymbols } from 'lib/prices/assets';
import {
  fetchHistoricalSeriesForCoin,
  fetchHistoricalSeriesForContract,
  type HistoricalPriceSeries,
  type HistoryWindow,
  priceAt,
  resolveEarliestPricedTimestamp,
} from 'lib/prices/historical';
import { syncAllExchangeAccounts } from 'lib/sync/exchanges';
import { deduplicateArray, groupBy } from 'lib/utils';
import { mapAsyncBounded } from 'lib/utils/promises';
import { DAY } from 'lib/utils/time';
import { formatUnits, getAddress } from 'viem';

export interface SnapshotReconstruction {
  // `created` is the only outcome that writes anything.
  //
  // The other two are refusals rather than failures, and both exist to avoid putting a number on the chart
  // that looks like a real one: a moment CoinGecko will not price would come out valued at nothing, and a
  // moment before any stored history begins would too.
  status: 'created' | 'beyond-plan-limit' | 'no-holdings';
  timestamp: number;
  totalUsd: number;
  positionCount: number;
  // Assets held at that moment whose historical price could not be retrieved, and which therefore
  // contribute nothing to the total.
  unpricedAssetCount: number;
  // Chains whose RPC could not serve historical state, so their native balance is missing from this point.
  // Reported rather than silently treated as zero, which would look like the holding had been sold.
  chainsWithoutNativeHistory: number[];
  // Collections valued at today's floor because no historical floor was available. CoinGecko's historical
  // NFT endpoint is paid-only, and covers only collections it indexes at all.
  nftCollectionsAtCurrentFloor: number;
  // The oldest moment the configured CoinGecko plan will price, when that is what blocked the request.
  earliestPricedTimestamp?: number;
}

export interface ReconstructionOptions {
  // Fetches every enabled account's transaction history before replaying it. Slow, and pointless for anyone
  // tracking only on-chain wallets, so the caller decides.
  includeExchangeHistory?: boolean;
  onProgress?: ReconstructionProgressListener;
}

const PRICE_FETCH_CONCURRENCY = 3;
const BLOCK_RESOLUTION_CONCURRENCY = 4;

// How far back to pull price history around the requested moment. CoinGecko returns hourly points for a
// range of this length, which is fine-grained enough to value a particular time of day, and `priceAt`
// carries the last point forward across any gap.
const PRICE_LOOKBACK = 7 * DAY;

// Reconstructs what the portfolio was worth at one moment, from the transfer events and exchange ledger
// already stored locally, and records it as a snapshot.
//
// Three things are worth knowing about the number this produces:
//
//   - Token balances are summed from transfer events, unlike current balances which are read from the
//     chain. That is exact for ordinary ERC20s but approximate for rebasing or fee-on-transfer tokens,
//     whose balances change without emitting a Transfer.
//   - Native balances cannot come from events at all, since moving ETH emits none, so they are read from
//     historical chain state and need an archive-capable RPC.
//   - Exchange balances are replayed from the exchange ledger, which is only present if it has been
//     fetched. Without it, a reconstructed point covers on-chain holdings alone.
export const reconstructSnapshotAt = async (
  timestamp: number,
  options: ReconstructionOptions = {},
): Promise<SnapshotReconstruction> => {
  if (timestamp > Date.now()) {
    throw new Error('A snapshot cannot be taken for a moment in the future.');
  }

  const progress = createReconstructionProgress(options.onProgress);

  const empty = {
    timestamp,
    totalUsd: 0,
    positionCount: 0,
    unpricedAssetCount: 0,
    chainsWithoutNativeHistory: [],
    nftCollectionsAtCurrentFloor: 0,
  };

  // Checked before any work is done. Every asset would come back unpriced, and a point worth nothing is
  // indistinguishable on the chart from a portfolio that really was empty.
  const earliestPriced = await resolveEarliestPricedTimestamp();
  if (earliestPriced !== null && timestamp < earliestPriced) {
    progress.skipRemaining();
    return { ...empty, status: 'beyond-plan-limit', earliestPricedTimestamp: earliestPriced };
  }

  await fetchExchangeHistory(progress, options.includeExchangeHistory === true);

  // The same floor the portfolio applies, so a reconstructed point counts the same holdings the dashboard
  // would have counted at that moment.
  const { spam } = await loadSettings();
  const dustThresholdAmount = spam.dustThresholdAmount;

  const events = await db.transferEvents.toArray();

  // A disabled exchange account is one the user has said is not part of their portfolio, so its history is
  // left out too. Without this the chart and the dashboard would disagree about the same money.
  const enabledAccounts = await db.exchangeAccounts.where('enabled').equals(1).toArray();
  const enabledAccountIds = new Set(enabledAccounts.map((account) => account.id));
  const ledgerEntries = (await db.exchangeLedger.toArray()).filter((entry) => enabledAccountIds.has(entry.accountId));

  const timestamps = [timestamp];
  const window: HistoryWindow = {
    from: Math.max(timestamp - PRICE_LOOKBACK, earliestPriced ?? Number.NEGATIVE_INFINITY),
    to: timestamp,
    truncated: false,
  };

  const fungibleEvents = events.filter((event) => event.standard === 'erc20');

  // Every chain that has any history, mapped to the block current at the requested moment.
  const chainIds = deduplicateArray(fungibleEvents.map((event) => event.chainId).map(String)).map(Number);
  const blocksByChain = await resolveBlocksForTimestamps(chainIds, timestamps, progress);

  const tokens = await db.tokens.toArray();
  const tokensById = new Map(tokens.map((token) => [token.id, token]));

  const balanceSeries = buildTokenBalanceSeries(fungibleEvents, timestamps, blocksByChain, tokensById);
  const collectionNames = await getCollectionNames();

  // Native tokens never appear in the event history, because moving ETH emits no log. They have to be read
  // from historical chain state instead, which is why this is a separate step rather than another series.
  const wallets = await db.wallets.where('enabled').equals(1).toArray();
  const owners = wallets.map((wallet) => getAddress(wallet.address));
  progress.start('reading-native-balances', owners.length > 0 ? chainIds.length : 0);
  const nativeBalances =
    owners.length > 0
      ? await readHistoricalNativeBalances(chainIds, owners, timestamps, blocksByChain, (completed) =>
          progress.advance('reading-native-balances', completed),
        )
      : { series: [], chainsWithoutArchiveAccess: [] };
  if (owners.length > 0) progress.complete('reading-native-balances');

  for (const nativeSeries of nativeBalances.series) {
    mergeNativeBalanceSeries(balanceSeries, nativeSeries);
  }

  const nftSeries = buildNftPositionSeries(events, timestamps, blocksByChain, collectionNames);
  const exchangeSeries = buildExchangeBalanceSeries(ledgerEntries, timestamps);

  // Manual holdings replay from their own ledger, which is the whole reason the ledger exists: without it a
  // hand-entered balance could only ever be valued at today's quantity, and every past point would claim
  // the user had always held it.
  const [manualBalances, manualLedger] = await Promise.all([
    db.manualBalances.where('enabled').equals(1).toArray(),
    db.manualLedger.toArray(),
  ]);
  const manualSeries = buildManualBalanceSeries(manualBalances, manualLedger, timestamps);
  const manualCoingeckoIds = new Map(
    manualBalances
      .filter((balance) => balance.coingeckoId)
      .map((balance) => [`manual:${balance.id}`, balance.coingeckoId as string]),
  );

  // Checked before any price is fetched. A date before the wallet held anything, or before its history was
  // synced, otherwise costs a full round of price requests to arrive at a total of nothing.
  const heldAnything =
    [...balanceSeries.values(), ...exchangeSeries.values(), ...manualSeries.values()].some(
      (series) => series.amounts[0] >= dustThresholdAmount,
    ) || [...nftSeries.values()].some((series) => series.counts[0] > 0);

  if (!heldAnything) {
    progress.skipRemaining();
    return { ...empty, status: 'no-holdings' };
  }

  // Only what was actually held at that moment gets a price lookup.
  //
  // The series cover every token the wallet has ever touched, and a position that had already been sold by
  // then is dropped when the snapshot is assembled anyway. Fetching its price first was work done purely to
  // throw away, and on a tight CoinGecko rate limit it was the difference between a reconstruction that
  // finishes and one that spends its whole budget on assets worth nothing.
  const heldBalanceKeys = keysHeldAt(balanceSeries, dustThresholdAmount);
  const heldExchangeKeys = keysHeldAt(exchangeSeries, dustThresholdAmount);
  const heldManualKeys = keysHeldAt(manualSeries, dustThresholdAmount);
  const heldCollectionKeys = [...nftSeries.entries()]
    .filter(([, series]) => series.counts[0] > 0)
    .map(([collectionKey]) => collectionKey);

  // An asset with no price today has none in the archive either, so asking is a request spent to be told
  // what we already know. Only a stored null counts: that is CoinGecko having answered "no price for this".
  // A token we have simply never asked about is still worth trying.
  const knownUnpricedKeys = await findKnownUnpricedKeys(heldBalanceKeys, tokensById);

  const priceSeriesByKey = await fetchPriceSeries(
    heldBalanceKeys.filter((priceKey) => !knownUnpricedKeys.has(priceKey)),
    heldExchangeKeys,
    heldManualKeys,
    { tokensById, manualCoingeckoIds },
    window,
    progress,
  );

  // Historical floors where the plan allows them, with the current floor as the fallback. This is the only
  // part of the point that cannot always be historically correct, so which one was used is reported back.
  const nftFloorPrices = await getCurrentNftFloorPrices();
  const nftFloorHistory = await fetchNftFloorHistory(heldCollectionKeys, window, progress);

  const positions: SnapshotPosition[] = [];
  progress.start(
    'valuing-positions',
    heldBalanceKeys.length + heldCollectionKeys.length + heldExchangeKeys.length + heldManualKeys.length,
  );

  for (const [priceKey, series] of balanceSeries) {
    const amount = series.amounts[0];
    if (amount < dustThresholdAmount) continue;

    const priceUsd = priceAt(priceSeriesByKey.get(priceKey) ?? { priceKey, points: [] }, timestamp);
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
    const count = series.counts[0];
    if (count === 0) continue;

    // A historical floor is preferred; the current floor stands in only where no history was available.
    const historicalFloor = nftFloorHistory.get(collectionKey);
    const floorPriceUsd =
      (historicalFloor ? priceAt(historicalFloor, timestamp) : null) ?? nftFloorPrices.get(collectionKey) ?? null;

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
    const amount = series.amounts[0];
    if (amount < dustThresholdAmount) continue;

    const priceUsd = priceAt(priceSeriesByKey.get(priceKey) ?? { priceKey, points: [] }, timestamp);
    positions.push({
      priceKey,
      symbol: series.symbol,
      amount,
      priceUsd,
      valueUsd: priceUsd === null ? 0 : amount * priceUsd,
      kind: 'exchange',
    });
  }

  for (const [priceKey, series] of manualSeries) {
    const amount = series.amounts[0];
    if (amount < dustThresholdAmount) continue;

    const priceUsd = priceAt(priceSeriesByKey.get(priceKey) ?? { priceKey, points: [] }, timestamp);
    positions.push({
      priceKey,
      symbol: series.symbol,
      amount,
      priceUsd,
      valueUsd: priceUsd === null ? 0 : amount * priceUsd,
      kind: 'manual',
    });
  }

  // Nothing held is reported rather than written. It is the honest answer for a date before the wallet
  // held anything, and it is also what a portfolio with no stored history looks like, so writing a zero
  // would turn "we do not know" into a claim.
  // Nothing held, or nothing that could be valued. A point worth zero is indistinguishable on the chart
  // from a portfolio that really was empty, which is the same reason recordCurrentSnapshot refuses one.
  const totalUsd = positions.reduce((total, position) => total + position.valueUsd, 0);
  if (positions.length === 0 || totalUsd === 0) return { ...empty, status: 'no-holdings' };

  const snapshot: StoredSnapshot = { timestamp, totalUsd, createdAt: Date.now(), positions };

  progress.complete('valuing-positions');

  await db.snapshots.put(snapshot);

  // Counted over what was held, which is the only thing that could have contributed. Counting every key in
  // the series would report tokens sold years earlier as having gone unpriced at this moment.
  const unpricedAssetCount = [...heldBalanceKeys, ...heldExchangeKeys, ...heldManualKeys].filter(
    (priceKey) => (priceSeriesByKey.get(priceKey)?.points.length ?? 0) === 0,
  ).length;

  return {
    status: 'created',
    timestamp,
    totalUsd: snapshot.totalUsd,
    positionCount: positions.length,
    unpricedAssetCount,
    chainsWithoutNativeHistory: nativeBalances.chainsWithoutArchiveAccess,
    nftCollectionsAtCurrentFloor: heldCollectionKeys.filter(
      (collectionKey) => (nftFloorHistory.get(collectionKey)?.points.length ?? 0) === 0,
    ).length,
  };
};

// Pulls each enabled account's transaction history, which is what an exchange balance is replayed from.
//
// Owned by the reconstruction rather than by the caller so that the progress covers the whole operation:
// this is the slowest step by far, and a page that showed nothing during it looked stuck.
const fetchExchangeHistory = async (
  progress: ReconstructionProgressReporter,
  includeExchangeHistory: boolean,
): Promise<void> => {
  if (!includeExchangeHistory) {
    progress.skip('exchange-history');
    return;
  }

  const accounts = await db.exchangeAccounts.where('enabled').equals(1).toArray();
  progress.start('exchange-history', accounts.length);
  if (accounts.length === 0) return;

  await syncAllExchangeAccounts({ includeLedger: true });
  progress.complete('exchange-history');
};

const resolveBlocksForTimestamps = async (
  chainIds: number[],
  timestamps: number[],
  progress: ReconstructionProgressReporter,
): Promise<Map<number, number[]>> => {
  const blocksByChain = new Map<number, number[]>();
  let completed = 0;

  progress.start('resolving-blocks', chainIds.length);

  await mapAsyncBounded(chainIds, BLOCK_RESOLUTION_CONCURRENCY, async (chainId) => {
    const blocks = await mapAsyncBounded(timestamps, 2, async (snapshotTimestamp) => {
      const blockNumber = await resolveBlockAtTimestamp(chainId, snapshotTimestamp).catch(() => undefined);
      // An unresolvable boundary is treated as "before this chain existed", which contributes nothing.
      return blockNumber ?? 0;
    });

    blocksByChain.set(chainId, blocks);
    completed += 1;
    progress.advance('resolving-blocks', completed);
  });

  progress.complete('resolving-blocks');
  return blocksByChain;
};

interface BalanceSeries {
  symbol: string;
  // One entry per requested moment, in the same order as `timestamps`.
  amounts: number[];
}

// Folds one chain's native balance history into the series for that coin.
//
// Summed rather than assigned, because every ETH rollup reports the same coin id: Base, Arbitrum and
// Ethereum all arrive as `ethereum`. Assigning would leave the chart showing whichever chain happened to be
// read last and silently understate the native holding.
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

// Walks each token's events once in block order while advancing through the timestamps, rather than re-scanning
// every event for every week. With hundreds of weeks and tens of thousands of events, the difference is
// between a fast rebuild and one that locks the tab.
const buildTokenBalanceSeries = (
  events: StoredTransferEvent[],
  timestamps: number[],
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

    for (let index = 0; index < timestamps.length; index += 1) {
      const blockAtTimestamp = chainBlocks[index];

      while (eventIndex < sorted.length && sorted[eventIndex].blockNumber <= blockAtTimestamp) {
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
  timestamps: number[],
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

    for (let index = 0; index < timestamps.length; index += 1) {
      const blockAtTimestamp = chainBlocks[index];

      while (eventIndex < sorted.length && sorted[eventIndex].blockNumber <= blockAtTimestamp) {
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
  timestamps: number[],
): Map<string, BalanceSeries> => {
  const series = new Map<string, BalanceSeries>();
  const entriesByAsset = groupBy(ledgerEntries, (entry) => entry.asset);

  for (const [asset, assetEntries] of entriesByAsset) {
    const sorted = [...assetEntries].sort((a, b) => a.timestamp - b.timestamp);

    const amounts: number[] = [];
    let runningBalance = 0;
    let entryIndex = 0;

    for (const snapshotTimestamp of timestamps) {
      while (entryIndex < sorted.length && sorted[entryIndex].timestamp <= snapshotTimestamp) {
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

const keysHeldAt = (series: Map<string, BalanceSeries>, dustThresholdAmount: number): string[] =>
  [...series.entries()].filter(([, entry]) => entry.amounts[0] >= dustThresholdAmount).map(([priceKey]) => priceKey);

// The price keys we already know CoinGecko has no price for.
//
// A current price is stored for every token held, including a null meaning "asked, and there is none". Both
// keys a token can be priced under are checked: its coin id if CoinGecko lists it, and its own contract for
// the on-chain pool price. A number under either means it is priced and worth asking about historically.
const findKnownUnpricedKeys = async (
  priceKeys: string[],
  tokensById: Map<string, StoredToken>,
): Promise<Set<string>> => {
  const prices = await db.prices.toArray();
  const pricesById = new Map(prices.map((price) => [price.id, price.priceUsd]));

  return new Set(
    priceKeys.filter((priceKey) => {
      const token = tokensById.get(priceKey);
      const coingeckoId = token?.coingeckoId;

      const candidates = [
        pricesById.get(priceKey),
        coingeckoId ? pricesById.get(coingeckoPriceKey(coingeckoId)) : undefined,
      ];

      // Priced under either key: keep it.
      if (candidates.some((price) => price !== null && price !== undefined)) return false;

      // Otherwise only skip when something was actually stored, so "never asked" still gets a try.
      return candidates.some((price) => price === null);
    }),
  );
};

// One series per manual balance rather than per coin.
//
// Keyed by the balance id, not by `coingecko:${id}`, because a native token series already uses that key
// shape: a manual ETH holding would land on top of the on-chain ETH series inside the same Map and one of
// them would silently disappear. Two manual balances of the same coin in different places also stay
// separate this way, which is what their locations mean.
const buildManualBalanceSeries = (
  balances: StoredManualBalance[],
  entries: StoredManualLedgerEntry[],
  timestamps: number[],
): Map<string, BalanceSeries> => {
  const entriesByBalance = groupEntriesByBalance(entries);
  const series = new Map<string, BalanceSeries>();

  for (const balance of balances) {
    const balanceEntries = entriesByBalance.get(balance.id) ?? [];
    if (balanceEntries.length === 0) continue;

    series.set(`manual:${balance.id}`, {
      symbol: balance.symbol.toUpperCase(),
      amounts: timestamps.map((timestamp) => amountAt(balanceEntries, timestamp)),
    });
  }

  return series;
};

interface PriceSources {
  tokensById: Map<string, StoredToken>;
  // Manual series key to the coin id the user chose to price that holding by.
  manualCoingeckoIds: Map<string, string>;
}

const fetchPriceSeries = async (
  tokenPriceKeys: string[],
  exchangePriceKeys: string[],
  manualPriceKeys: string[],
  sources: PriceSources,
  window: HistoryWindow,
  progress: ReconstructionProgressReporter,
): Promise<Map<string, HistoricalPriceSeries>> => {
  const seriesByKey = new Map<string, HistoricalPriceSeries>();

  // Skipped entirely when nothing was held on an exchange, since resolving tickers pulls the market map.
  const exchangeSymbols = exchangePriceKeys.map((key) => key.replace('exchange-asset:', ''));
  const coingeckoIdsBySymbol =
    exchangeSymbols.length > 0 ? await resolveCoinGeckoIdsForSymbols(exchangeSymbols) : new Map<string, string>();

  // Manual holdings are keyed by balance so that two of them, or a manual holding and a native one, cannot
  // overwrite each other in the series map. Their prices are another matter: several holdings can share a
  // coin, so they are fetched once per coin and the result handed to each holding that asked for it.
  const manualKeysByCoin = new Map<string, string[]>();
  for (const priceKey of manualPriceKeys) {
    const coingeckoId = sources.manualCoingeckoIds.get(priceKey);
    if (!coingeckoId) {
      // No price source is a choice the user made: the holding is a quantity and nothing more.
      seriesByKey.set(priceKey, { priceKey, points: [] });
      continue;
    }

    const existing = manualKeysByCoin.get(coingeckoId);
    if (existing) {
      existing.push(priceKey);
    } else {
      manualKeysByCoin.set(coingeckoId, [priceKey]);
    }
  }

  const allKeys = [...tokenPriceKeys, ...exchangePriceKeys, ...manualKeysByCoin.keys()];
  let completed = 0;

  progress.start('fetching-prices', allKeys.length);

  await mapAsyncBounded(allKeys, PRICE_FETCH_CONCURRENCY, async (priceKey) => {
    const manualKeys = manualKeysByCoin.get(priceKey);

    if (manualKeys) {
      // Stored under the coin's own price key, so the rows are shared with every other holding of it rather
      // than duplicated once per manual balance.
      const series = await fetchHistoricalSeriesForCoin(priceKey, coingeckoPriceKey(priceKey), window);
      for (const manualKey of manualKeys) seriesByKey.set(manualKey, { ...series, priceKey: manualKey });
    } else {
      seriesByKey.set(priceKey, await fetchSeriesForKey(priceKey, sources, coingeckoIdsBySymbol, window));
    }

    completed += 1;
    progress.advance('fetching-prices', completed);
  });

  progress.complete('fetching-prices');
  return seriesByKey;
};

const fetchSeriesForKey = async (
  priceKey: string,
  sources: PriceSources,
  coingeckoIdsBySymbol: Map<string, string>,
  window: HistoryWindow,
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
  const token = sources.tokensById.get(`${chainId}:${address}`);

  if (!token) return { priceKey, points: [] };

  return fetchHistoricalSeriesForContract(chainId, address, priceKey, window);
};

// Historical floor prices, one series per collection, for the collections CoinGecko has an id for.
//
// Collections with no id, and every collection when the key is not a paid one, come back empty and are
// valued at the current floor instead.
const fetchNftFloorHistory = async (
  collectionKeys: string[],
  window: HistoryWindow,
  progress: ReconstructionProgressReporter,
): Promise<Map<string, HistoricalPriceSeries>> => {
  const collections = await db.nftCollections.bulkGet(collectionKeys);
  const withCoingeckoId = collections.flatMap((collection) =>
    collection?.coingeckoNftId ? [{ key: collection.id, coingeckoNftId: collection.coingeckoNftId }] : [],
  );

  const historyByCollection = new Map<string, HistoricalPriceSeries>();

  progress.start('fetching-nft-floors', withCoingeckoId.length);
  if (withCoingeckoId.length === 0) return historyByCollection;

  let completed = 0;

  await mapAsyncBounded(withCoingeckoId, PRICE_FETCH_CONCURRENCY, async (collection) => {
    const series = await fetchCoinGeckoNftFloorHistory(collection.coingeckoNftId, collection.key, window);
    if (series.points.length > 0) historyByCollection.set(collection.key, series);

    completed += 1;
    progress.advance('fetching-nft-floors', completed);
  });

  progress.complete('fetching-nft-floors');
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
