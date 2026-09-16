import { getChainConfigSafe } from 'lib/chains';
import { createEnabledChainFilter } from 'lib/chains/enabled';
import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import { db } from 'lib/db';
import type {
  SnapshotChainBalance,
  SnapshotNftHolding,
  SnapshotScope,
  SnapshotTokenMetadata,
  StoredSnapshot,
  StoredToken,
  StoredWallet,
} from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';
import { resolveBlocksForTimestamps } from 'lib/history/blocks';
import { readHistoricalNativeBalances } from 'lib/history/native-balances';
import { currentWalletScope, diffWallets, normaliseOwners, scopeMatches, scopeMeasuredBy } from 'lib/history/scope';
import { buildNftPositionSeries, buildTokenBalanceSeries } from 'lib/history/series';
import { computeSnapshotTotalUsd } from 'lib/portfolio/snapshot-lens';
import {
  fetchHistoricalSeriesForCoin,
  fetchHistoricalSeriesForContract,
  type HistoricalPriceSeries,
  type HistoryWindow,
  priceAt,
} from 'lib/prices/historical';
import { deduplicateArray } from 'lib/utils';
import { mapAsyncBounded } from 'lib/utils/promises';
import { formatUnits, getAddress } from 'viem';

export type WalletScopeMethod = 'subtract' | 'fold-in' | 'rebuild';

export interface WalletScopePreviewEntry {
  timestamp: number;
  totalUsdBefore: number;
  totalUsdAfter: number;
  method: WalletScopeMethod;
}

export interface WalletScopeProgress {
  phase: 'resolving-blocks' | 'reading-native-balances' | 'fetching-prices' | 'updating-snapshots';
  completed: number;
  total: number;
}

export interface WalletScopeResult {
  status: 'updated' | 'no-snapshots' | 'no-wallets' | 'in-scope' | 'needs-rebuild';
  snapshotsExamined: number;
  // How many were corrected by each mechanism. Subtraction is exact and free; the other two replay events.
  snapshotsSubtracted: number;
  snapshotsFoldedIn: number;
  snapshotsRebuilt: number;
  // Of those, how many actually moved a figure. Stamping a snapshot that was already correctly scoped
  // changes a record without changing the chart, and should not be reported as if it had.
  snapshotsChanged: number;
  // Points that still count a wallet you no longer track, and cannot be corrected by arithmetic because
  // their rows do not say who contributed them.
  snapshotsWithUnattributedRemovals: number;
  // Points left alone because correcting them would have emptied them.
  snapshotsWouldEmpty: number;
  unpricedPositionCount: number;
  chainsWithoutArchiveState: number[];
  // Whether this was a dry run. Stated outright rather than inferred from the presence of the preview,
  // which is returned either way so an applied run can also show what moved.
  isDryRun: boolean;
  preview: WalletScopePreviewEntry[];
}

export interface WalletScopeOptions {
  // Reports what would change and writes nothing.
  dryRun?: boolean;
  // Rebuilds points whose scope only *looks* right. The one way to correct a wallet removed before its
  // rows were attributed, and the only path that replaces measured balances with replayed ones.
  rebuildUnstamped?: boolean;
  onProgress?: (progress: WalletScopeProgress) => void;
}

const OWNER_REPLAY_CONCURRENCY = 3;
const PRICE_FETCH_CONCURRENCY = 3;

// Makes the history measure the same portfolio the app measures today.
//
// Snapshots store per-owner rows, which is what makes this mostly arithmetic: removing a wallet from a
// point is dropping its rows, and adding one is inserting rows replayed from its stored events. Only rows
// a reconstruction wrote, whose owner is blank, cannot be taken apart, and those need the opt-in rebuild.
//
// Two prohibitions, the same ones the manual reprocess states: it never creates a snapshot and never
// deletes one, and it never touches exchange or manual rows, which belong to no wallet.
export const reprocessWalletScope = async (options: WalletScopeOptions = {}): Promise<WalletScopeResult> => {
  const snapshots = await db.snapshots.orderBy('timestamp').toArray();

  const empty: WalletScopeResult = {
    status: 'no-snapshots',
    snapshotsExamined: snapshots.length,
    snapshotsSubtracted: 0,
    snapshotsFoldedIn: 0,
    snapshotsRebuilt: 0,
    snapshotsChanged: 0,
    snapshotsWithUnattributedRemovals: 0,
    snapshotsWouldEmpty: 0,
    unpricedPositionCount: 0,
    chainsWithoutArchiveState: [],
    isDryRun: options.dryRun === true,
    preview: [],
  };

  if (snapshots.length === 0) return empty;

  const wallets = await db.wallets.toArray();

  // With nothing tracked there is no scope to match. Continuing would strip every attributed row and
  // flatten the chart to whatever sits on exchanges.
  if (wallets.length === 0) return { ...empty, status: 'no-wallets' };

  const [current, { spam }] = await Promise.all([currentWalletScope(), loadSettings()]);

  const plans = snapshots.map((snapshot) => planFor(snapshot, wallets, current, options.rebuildUnstamped === true));
  const drifted = plans.filter((plan) => plan.method !== undefined);

  // Counted over every point rather than over the ones being corrected, because a point that cannot be
  // corrected is exactly the one worth telling the user about.
  const snapshotsWithUnattributedRemovals = plans.filter(
    (plan) => plan.unattributedRemovals.length > 0 && plan.method !== 'rebuild',
  ).length;

  if (drifted.length === 0) {
    const status = snapshotsWithUnattributedRemovals > 0 ? 'needs-rebuild' : 'in-scope';
    return { ...empty, status, snapshotsWithUnattributedRemovals };
  }

  // One replay per group rather than one per snapshot: the series builders walk their events once while
  // advancing through the timestamps, so a hundred moments cost barely more than one.
  const foldIn = drifted.filter((plan) => plan.method === 'fold-in');
  const rebuild = drifted.filter((plan) => plan.method === 'rebuild');

  const foldInReplay =
    foldIn.length > 0
      ? await replayOwnerRows(
          foldIn.map((plan) => plan.snapshot.timestamp),
          deduplicateArray(foldIn.flatMap((plan) => plan.added)),
          spam.dustThresholdAmount,
          options.onProgress,
        )
      : undefined;

  const rebuildReplay =
    rebuild.length > 0
      ? await replayOwnerRows(
          rebuild.map((plan) => plan.snapshot.timestamp),
          current.wallets,
          spam.dustThresholdAmount,
          options.onProgress,
        )
      : undefined;

  const historicalPrices = await resolveResidualPrices([foldInReplay, rebuildReplay], plans, options.onProgress);

  const result: WalletScopeResult = {
    ...empty,
    status: 'updated',
    snapshotsWithUnattributedRemovals,
    chainsWithoutArchiveState: deduplicateArray([
      ...(foldInReplay?.chainsWithoutArchiveState ?? []),
      ...(rebuildReplay?.chainsWithoutArchiveState ?? []),
    ]),
  };

  const updated: StoredSnapshot[] = [];
  const preview: WalletScopePreviewEntry[] = [];

  for (const [index, plan] of drifted.entries()) {
    const replay = plan.method === 'rebuild' ? rebuildReplay : foldInReplay;
    const momentIndex =
      plan.method === 'rebuild'
        ? rebuild.findIndex((entry) => entry.snapshot.timestamp === plan.snapshot.timestamp)
        : foldIn.findIndex((entry) => entry.snapshot.timestamp === plan.snapshot.timestamp);

    const corrected = buildCorrectedSnapshot(plan, replay, momentIndex, historicalPrices, current);
    if (!corrected) {
      result.snapshotsWouldEmpty += 1;
      continue;
    }

    if (plan.method === 'subtract') result.snapshotsSubtracted += 1;
    if (plan.method === 'fold-in') result.snapshotsFoldedIn += 1;
    if (plan.method === 'rebuild') result.snapshotsRebuilt += 1;

    result.unpricedPositionCount += corrected.unpricedCount;

    // Valued through the same aggregation the pinned view renders with, under today's filters.
    corrected.snapshot.totalUsd = await computeSnapshotTotalUsd(corrected.snapshot);

    if (Math.abs(corrected.snapshot.totalUsd - plan.snapshot.totalUsd) > 0.005) result.snapshotsChanged += 1;

    preview.push({
      timestamp: plan.snapshot.timestamp,
      totalUsdBefore: plan.snapshot.totalUsd,
      totalUsdAfter: corrected.snapshot.totalUsd,
      method: plan.method as WalletScopeMethod,
    });

    updated.push(corrected.snapshot);
    options.onProgress?.({ phase: 'updating-snapshots', completed: index + 1, total: drifted.length });
  }

  if (options.dryRun) return { ...result, preview };

  await writeIfUnchanged(updated, plans);

  return { ...result, preview };
};

interface SnapshotPlan {
  snapshot: StoredSnapshot;
  measured: SnapshotScope;
  added: string[];
  removed: string[];
  removableNow: string[];
  unattributedRemovals: string[];
  method?: WalletScopeMethod;
}

// Which mechanism a point needs, decided before a single request is made.
const planFor = (
  snapshot: StoredSnapshot,
  wallets: StoredWallet[],
  current: SnapshotScope,
  rebuildUnstamped: boolean,
): SnapshotPlan => {
  const measured = scopeMeasuredBy(snapshot, wallets, current);
  const { added, removed } = diffWallets(measured.wallets, current.wallets);

  // A wallet is removable exactly when its rows carry its address. Reconstructed rows carry none, and the
  // explicit list additionally covers wallets that were measured and held nothing.
  const rowOwners = new Set([
    ...(snapshot.balances ?? []).map((balance) => balance.owner),
    ...(snapshot.nftHoldings ?? []).map((holding) => holding.owner),
  ]);
  rowOwners.delete('');
  const attributed = new Set([...(snapshot.attributedOwners ?? []), ...rowOwners]);

  const removableNow = removed.filter((owner) => attributed.has(owner));
  const unattributedRemovals = removed.filter((owner) => !attributed.has(owner));

  const plan: SnapshotPlan = { snapshot, measured, added, removed, removableNow, unattributedRemovals };

  if (rebuildUnstamped) return { ...plan, method: 'rebuild' };
  if (added.length > 0) return { ...plan, method: 'fold-in' };
  if (removableNow.length > 0) return { ...plan, method: 'subtract' };

  // A wallet this point cannot account for. Rebuilding would correct the scope, but it would also replace
  // every balance in the point with a replayed estimate, which is not a trade to make on the user's behalf
  // without asking. Reported instead, and corrected only when they ask for it.
  if (unattributedRemovals.length > 0) return plan;

  if (scopeMatches(measured, current)) return plan;

  // The chain axis moved without the wallets moving. Replaying is the only way to apply that.
  return { ...plan, method: 'rebuild' };
};

interface OwnerRowReplay {
  // One entry per requested moment, index-aligned with the timestamps handed in.
  balancesByMoment: SnapshotChainBalance[][];
  nftHoldingsByMoment: SnapshotNftHolding[][];
  tokenMetadata: Map<string, SnapshotTokenMetadata>;
  collectionNames: Map<string, string>;
  chainsWithoutArchiveState: number[];
}

// Replays a set of wallets over a set of moments, producing the same per-owner rows a live snapshot
// stores. Per owner rather than combined, so each wallet's running balance is clamped alone and every row
// says whose it is: a wallet folded in today can be taken back out tomorrow by dropping its rows.
const replayOwnerRows = async (
  timestamps: number[],
  owners: string[],
  dustThresholdAmount: number,
  onProgress?: (progress: WalletScopeProgress) => void,
): Promise<OwnerRowReplay> => {
  const lowercaseOwners = normaliseOwners(owners);

  const [events, storedBalances, cursors, settings, collections] = await Promise.all([
    db.transferEvents.where('owner').anyOf(lowercaseOwners).toArray(),
    db.balances.where('owner').anyOf(lowercaseOwners).toArray(),
    db.syncCursors.where('owner').anyOf(lowercaseOwners).toArray(),
    loadSettings(),
    db.nftCollections.toArray(),
  ]);

  // Every chain these wallets have touched, from three sources because no one of them is complete: events
  // miss a chain where only the native coin was ever held, balances are deleted when they reach zero, and
  // cursors record every chain that was ever synced for the wallet.
  const isChainEnabled = createEnabledChainFilter(settings.sync);
  const chainIds = deduplicateArray([
    ...events.map((event) => event.chainId),
    ...storedBalances.map((balance) => balance.chainId),
    ...cursors.map((cursor) => cursor.chainId),
  ]).filter(isChainEnabled);

  const blocksByChain = await resolveBlocksForTimestamps(chainIds, timestamps, (completed, total) =>
    onProgress?.({ phase: 'resolving-blocks', completed, total }),
  );

  const tokensById = new Map((await db.tokens.toArray()).map((token) => [token.id, token]));
  const collectionNames = new Map(
    collections.map((collection) => [collection.id, collection.name ?? collection.symbol ?? collection.address]),
  );

  const balancesByMoment: SnapshotChainBalance[][] = timestamps.map(() => []);
  const nftHoldingsByMoment: SnapshotNftHolding[][] = timestamps.map(() => []);
  const tokenMetadata = new Map<string, SnapshotTokenMetadata>();
  const chainsWithoutArchiveState: number[] = [];

  let completedOwners = 0;

  await mapAsyncBounded(lowercaseOwners, OWNER_REPLAY_CONCURRENCY, async (owner) => {
    const ownerEvents = events.filter((event) => event.owner === owner);

    // Contract holdings from the event replay. Native coins are keyed by coin id in the series and come
    // from the archive reads below instead, where their chain identity survives.
    const ownerSeries = buildTokenBalanceSeries(
      ownerEvents.filter((event) => event.standard === 'erc20'),
      timestamps,
      blocksByChain,
      tokensById,
    );

    for (const [priceKey, series] of ownerSeries) {
      if (priceKey.startsWith('coingecko:')) continue;

      const token = tokensById.get(priceKey);
      if (!token || token.decimals === undefined) continue;

      tokenMetadata.set(token.id, {
        id: token.id,
        chainId: token.chainId,
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        coingeckoId: token.coingeckoId,
        isSpam: token.isSpam,
        spamReason: token.spamReason,
      });

      series.amounts.forEach((amount, momentIndex) => {
        if (amount < dustThresholdAmount) return;
        balancesByMoment[momentIndex].push({
          chainId: token.chainId,
          owner,
          token: token.address,
          amount: floatToRawUnits(amount, token.decimals as number),
        });
      });
    }

    const native = await readHistoricalNativeBalances(chainIds, [getAddress(owner)], timestamps, blocksByChain).catch(
      () => ({ series: [], chainsWithoutArchiveAccess: chainIds }),
    );
    chainsWithoutArchiveState.push(...native.chainsWithoutArchiveAccess);

    for (const nativeSeries of native.series) {
      const chain = getChainConfigSafe(nativeSeries.chainId);
      if (!chain?.isSupported()) continue;

      const decimals = chain.getNativeTokenDecimals();
      const nativeAddress = NATIVE_TOKEN_ADDRESS.toLowerCase();
      const id = `${nativeSeries.chainId}:${nativeAddress}`;

      tokenMetadata.set(id, {
        id,
        chainId: nativeSeries.chainId,
        address: nativeAddress,
        symbol: nativeSeries.symbol,
        decimals,
        coingeckoId: nativeSeries.coingeckoId,
      });

      nativeSeries.amounts.forEach((amount, momentIndex) => {
        if (amount === undefined || amount < dustThresholdAmount) return;
        balancesByMoment[momentIndex].push({
          chainId: nativeSeries.chainId,
          owner,
          token: nativeAddress,
          amount: floatToRawUnits(amount, decimals),
        });
      });
    }

    const ownerNfts = buildNftPositionSeries(ownerEvents, timestamps, blocksByChain, collectionNames);
    for (const [collectionKey, series] of ownerNfts) {
      const [chainIdPart, address] = collectionKey.split(':');

      series.counts.forEach((count, momentIndex) => {
        if (count === 0) return;
        nftHoldingsByMoment[momentIndex].push({
          chainId: Number(chainIdPart),
          collection: address,
          owner,
          count,
        });
      });
    }

    completedOwners += 1;
    onProgress?.({ phase: 'reading-native-balances', completed: completedOwners, total: lowercaseOwners.length });
  });

  return {
    balancesByMoment,
    nftHoldingsByMoment,
    tokenMetadata,
    collectionNames,
    chainsWithoutArchiveState: deduplicateArray(chainsWithoutArchiveState),
  };
};

// Prices for keys no drifted snapshot already carries.
//
// Snapshot prices live in the same key space the replay produces, so carry-over is a straight lookup: a
// price the point recorded at the time beats a daily historical bucket, and fetching is reserved for
// assets no point has ever priced. For a pure removal the residual list is empty and nothing is fetched.
const resolveResidualPrices = async (
  replays: Array<OwnerRowReplay | undefined>,
  plans: SnapshotPlan[],
  onProgress?: (progress: WalletScopeProgress) => void,
): Promise<Map<string, HistoricalPriceSeries>> => {
  const recordedKeys = new Set(
    plans.flatMap((plan) =>
      (plan.snapshot.prices ?? []).filter((price) => price.priceUsd !== null).map((price) => price.id),
    ),
  );

  const residualKeys = new Set<string>();
  for (const replay of replays) {
    if (!replay) continue;
    for (const token of replay.tokenMetadata.values()) {
      const contractKey = token.id;
      const coinKey = token.coingeckoId ? `coingecko:${token.coingeckoId}` : undefined;
      if (!recordedKeys.has(contractKey) && !(coinKey && recordedKeys.has(coinKey))) {
        residualKeys.add(coinKey ?? contractKey);
      }
    }
  }

  const seriesByKey = new Map<string, HistoricalPriceSeries>();
  if (residualKeys.size === 0) return seriesByKey;

  const timestamps = plans.map((plan) => plan.snapshot.timestamp);
  const window: HistoryWindow = { from: Math.min(...timestamps), to: Math.max(...timestamps), truncated: false };

  const keys = [...residualKeys];
  let completed = 0;
  onProgress?.({ phase: 'fetching-prices', completed, total: keys.length });

  await mapAsyncBounded(keys, PRICE_FETCH_CONCURRENCY, async (key) => {
    const series = await fetchSeriesForPriceKey(key, window).catch(() => undefined);
    if (series) seriesByKey.set(key, series);

    completed += 1;
    onProgress?.({ phase: 'fetching-prices', completed, total: keys.length });
  });

  return seriesByKey;
};

const fetchSeriesForPriceKey = async (
  key: string,
  window: HistoryWindow,
): Promise<HistoricalPriceSeries | undefined> => {
  if (key.startsWith('coingecko:')) {
    return fetchHistoricalSeriesForCoin(key.slice('coingecko:'.length), key, window);
  }

  const [chainIdPart, address] = key.split(':');
  return fetchHistoricalSeriesForContract(Number(chainIdPart), address, key, window);
};

interface CorrectedSnapshot {
  snapshot: StoredSnapshot;
  unpricedCount: number;
}

// Applies one plan to one snapshot's rows. Returns undefined when the correction would empty a point that
// recorded something: a point that measured something must never become a point that measured nothing.
const buildCorrectedSnapshot = (
  plan: SnapshotPlan,
  replay: OwnerRowReplay | undefined,
  momentIndex: number,
  historicalPrices: Map<string, HistoricalPriceSeries>,
  current: SnapshotScope,
): CorrectedSnapshot | undefined => {
  const { snapshot } = plan;
  const removedSet = new Set(plan.method === 'rebuild' ? [] : plan.removableNow);
  const hadOnChain = (snapshot.balances?.length ?? 0) + (snapshot.nftHoldings?.length ?? 0) > 0;

  // What survives of the recorded rows: a rebuild keeps none, a fold-in strips the added owners' previous
  // rows so a second run converges instead of doubling, and a subtract strips the removed owners'.
  const strippedOwners = new Set(plan.method === 'rebuild' ? [] : [...removedSet, ...plan.added]);
  let balances = (snapshot.balances ?? []).filter((balance) => !strippedOwners.has(balance.owner));
  let nftHoldings = (snapshot.nftHoldings ?? []).filter((holding) => !strippedOwners.has(holding.owner));
  if (plan.method === 'rebuild') {
    balances = [];
    nftHoldings = [];
  }

  const tokens = new Map((plan.method === 'rebuild' ? [] : (snapshot.tokens ?? [])).map((token) => [token.id, token]));
  const prices = new Map((snapshot.prices ?? []).map((price) => [price.id, price.priceUsd]));
  const collections = new Map(
    (plan.method === 'rebuild' ? [] : (snapshot.nftCollections ?? [])).map((collection) => [collection.id, collection]),
  );

  let unpricedCount = 0;

  if (plan.method !== 'subtract') {
    if (!replay || momentIndex < 0) return undefined;

    balances = [...balances, ...replay.balancesByMoment[momentIndex]];
    nftHoldings = [...nftHoldings, ...replay.nftHoldingsByMoment[momentIndex]];

    const referencedTokenIds = new Set(balances.map((balance) => `${balance.chainId}:${balance.token}`));
    for (const token of replay.tokenMetadata.values()) {
      if (referencedTokenIds.has(token.id)) tokens.set(token.id, token);
    }

    // Prices: the point's own recorded figure wins; the fetched series fills only genuine gaps.
    for (const token of tokens.values()) {
      const contractKey = token.id;
      const coinKey = token.coingeckoId ? `coingecko:${token.coingeckoId}` : undefined;
      if (typeof prices.get(contractKey) === 'number' || (coinKey && typeof prices.get(coinKey) === 'number')) {
        continue;
      }

      const series = historicalPrices.get(coinKey ?? contractKey);
      const priceUsd = series ? priceAt(series, snapshot.timestamp) : null;
      prices.set(coinKey ?? contractKey, priceUsd);
      if (priceUsd === null) unpricedCount += 1;
    }

    for (const holding of nftHoldings) {
      const id = `${holding.chainId}:${holding.collection}`;
      if (!collections.has(id)) {
        collections.set(id, {
          id,
          chainId: holding.chainId,
          address: holding.collection,
          name: replay.collectionNames.get(id),
          // A collection this point never valued has no floor of that moment; today's floor would be an
          // anachronism dressed as a fact, so it stays unvalued and is counted in the summary.
          floorPriceUsd: null,
        });
      }
    }
  }

  if (hadOnChain && balances.length === 0 && nftHoldings.length === 0) return undefined;

  // Prune what nothing references any more, so a subtracted point does not carry metadata for holdings it
  // no longer contains.
  const referencedTokenIds = new Set(balances.map((balance) => `${balance.chainId}:${balance.token}`));
  const referencedCollectionIds = new Set(nftHoldings.map((holding) => `${holding.chainId}:${holding.collection}`));

  const attributedOwners = normaliseOwners([
    ...(plan.method === 'rebuild'
      ? current.wallets
      : (snapshot.attributedOwners ?? []).filter((owner) => !removedSet.has(owner))),
    ...plan.added,
  ]);

  return {
    snapshot: {
      ...snapshot,
      balances,
      nftHoldings,
      tokens: [...tokens.values()].filter((token) => referencedTokenIds.has(token.id)),
      nftCollections: [...collections.values()].filter((collection) => referencedCollectionIds.has(collection.id)),
      prices: [...prices.entries()].map(([id, priceUsd]) => ({ id, priceUsd })),
      scope: current,
      attributedOwners,
    },
    unpricedCount,
  };
};

// Written only where the row is still the one that was read.
//
// A run takes minutes, and in that time the History page's delete button is live, a sync can end with a
// new snapshot, and the manual reprocess can rewrite the same rows. Checking existence stops a deleted
// point being resurrected; checking `createdAt` stops another writer's version being overwritten by one
// computed from rows that are now stale.
const writeIfUnchanged = async (updated: StoredSnapshot[], plans: SnapshotPlan[]): Promise<void> => {
  if (updated.length === 0) return;

  const baselineCreatedAt = new Map(plans.map((plan) => [plan.snapshot.timestamp, plan.snapshot.createdAt]));

  await db.transaction('rw', db.snapshots, async () => {
    const existing = await db.snapshots.bulkGet(updated.map((snapshot) => snapshot.timestamp));

    const safe = updated.filter((snapshot, index) => {
      const currentRow = existing[index];
      return currentRow !== undefined && currentRow.createdAt === baselineCreatedAt.get(snapshot.timestamp);
    });

    if (safe.length > 0) await db.snapshots.bulkPut(safe);
  });
};

// A replayed float amount converted back to raw units. String arithmetic rather than
// BigInt(amount * 10 ** decimals), which overflows the float long before it overflows the token.
const floatToRawUnits = (amount: number, decimals: number): string => {
  const fractionDigits = Math.min(decimals, 20);
  const [whole, fraction = ''] = Math.max(0, amount).toFixed(fractionDigits).split('.');
  const raw = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  return raw === '' ? '0' : raw;
};
