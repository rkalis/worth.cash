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
import { resolveBlocksForTimestamps } from 'lib/history/blocks';
import { readHistoricalNativeBalances } from 'lib/history/native-balances';
import {
  createReconstructionProgress,
  type ReconstructionProgressListener,
  type ReconstructionProgressReporter,
} from 'lib/history/progress';
import {
  type BalanceSeries,
  buildExchangeBalanceSeries,
  buildManualBalanceSeries,
  buildNftPositionSeries,
  buildTokenBalanceSeries,
  keysHeldAt,
  mergeNativeBalanceSeries,
} from 'lib/history/series';
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

export { mergeNativeBalanceSeries } from 'lib/history/series';

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
  progress.start('resolving-blocks', chainIds.length);
  const blocksByChain = await resolveBlocksForTimestamps(chainIds, timestamps, (completed) =>
    progress.advance('resolving-blocks', completed),
  );
  progress.complete('resolving-blocks');

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
  if (positions.length === 0 || totalUsd === 0) {
    // Reached in the middle of the valuing phase, so the step list has to be closed out or the UI sits on
    // a phase that will never finish.
    progress.skipRemaining();
    return { ...empty, status: 'no-holdings' };
  }

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
