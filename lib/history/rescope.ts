import { createEnabledChainFilter } from 'lib/chains/enabled';
import { db } from 'lib/db';
import type { SnapshotPosition, SnapshotScope, StoredSnapshot, StoredToken, StoredWallet } from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';
import { subtractOwners } from 'lib/history/attribution';
import { resolveBlocksForTimestamps } from 'lib/history/blocks';
import { readHistoricalNativeBalances } from 'lib/history/native-balances';
import { currentWalletScope, diffWallets, normaliseOwners, scopeMatches, scopeMeasuredBy } from 'lib/history/scope';
import {
  type BalanceSeries,
  buildNftPositionSeries,
  buildTokenBalanceSeries,
  mergeNativeBalanceSeries,
  type NftSeries,
} from 'lib/history/series';
import {
  fetchHistoricalSeriesForCoin,
  fetchHistoricalSeriesForContract,
  type HistoricalPriceSeries,
  type HistoryWindow,
  priceAt,
} from 'lib/prices/historical';
import { deduplicateArray } from 'lib/utils';
import { mapAsyncBounded } from 'lib/utils/promises';
import { getAddress } from 'viem';

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
  // they were recorded before the app noted who contributed what.
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
  // Rebuilds points whose scope only *looks* right. The one way to correct a wallet removed before the app
  // started recording attribution, and the only path that replaces measured balances with replayed ones.
  rebuildUnstamped?: boolean;
  onProgress?: (progress: WalletScopeProgress) => void;
}

const OWNER_REPLAY_CONCURRENCY = 3;
const PRICE_FETCH_CONCURRENCY = 3;

// Makes the history measure the same portfolio the app measures today.
//
// A snapshot records what was found, not what was looked at, so adding a wallet leaves every existing point
// silently measuring a smaller portfolio, and the first sync afterwards draws a step that looks like a gain
// and is not. This corrects the record rather than the arithmetic: it changes which wallets a point counts,
// and nothing else.
//
// Two prohibitions, the same ones the manual reprocess states:
//
//   - It never creates a snapshot and never deletes one. Which moments are worth recording is the user's
//     decision, and inventing or dropping points here would put figures on the chart they never asked for.
//   - It never touches an `exchange` or `manual` position. Those belong to no wallet and have their own
//     lifecycle.
//
// Three mechanisms, chosen per snapshot, in order of how much they cost the truth:
//
//   - `subtract`: the point records who contributed what, so a wallet's share comes out by arithmetic at
//     the price already recorded. Exact, and not a single network request.
//   - `fold-in`: a newly tracked wallet's history is replayed and merged in. Every figure already in the
//     point stays exactly as it was read from the chain; only the new wallet's part is an estimate.
//   - `rebuild`: everything on-chain is replayed from the wallets that remain. The only thing that can
//     correct a wallet removed before attribution existed, and the only one that replaces measured balances
//     with replayed ones, so it is opt-in and never reached by default.
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

  // With nothing tracked there is no scope to match. Continuing would strip every attributed position and
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
    // Nothing correctable. Which of those two situations it is matters: one means the history already
    // agrees with the present, the other means it does not and only a rebuild can make it.
    const status = snapshotsWithUnattributedRemovals > 0 ? 'needs-rebuild' : 'in-scope';
    return { ...empty, status, snapshotsWithUnattributedRemovals };
  }

  // One replay per group rather than one per snapshot. Every series builder walks its events once while
  // advancing through the timestamps, and a price series covers a range, so asking about a hundred moments
  // together costs barely more than asking about one.
  const foldIn = drifted.filter((plan) => plan.method === 'fold-in');
  const rebuild = drifted.filter((plan) => plan.method === 'rebuild');

  const foldInReplay =
    foldIn.length > 0
      ? await replayOwners(
          foldIn.map((plan) => plan.snapshot.timestamp),
          deduplicateArray(foldIn.flatMap((plan) => plan.added)),
          spam.dustThresholdAmount,
          options.onProgress,
        )
      : undefined;

  const rebuildReplay =
    rebuild.length > 0
      ? await replayOwners(
          rebuild.map((plan) => plan.snapshot.timestamp),
          current.wallets,
          spam.dustThresholdAmount,
          options.onProgress,
        )
      : undefined;

  const tokensById = new Map((await db.tokens.toArray()).map((token) => [token.id, token]));

  // Prices come from the snapshots themselves wherever possible; only assets no point has ever priced need
  // asking about. See `resolvePrices`.
  const historicalPrices = await resolvePrices([foldInReplay, rebuildReplay], plans, tokensById, options.onProgress);

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

  drifted.forEach((plan, index) => {
    const replay = plan.method === 'rebuild' ? rebuildReplay : foldInReplay;
    const timestampIndex =
      plan.method === 'rebuild'
        ? rebuild.findIndex((entry) => entry.snapshot.timestamp === plan.snapshot.timestamp)
        : foldIn.findIndex((entry) => entry.snapshot.timestamp === plan.snapshot.timestamp);

    const rebuilt = buildPositions(
      plan,
      replay,
      timestampIndex,
      tokensById,
      historicalPrices,
      spam.dustThresholdAmount,
    );
    if (!rebuilt) {
      result.snapshotsWouldEmpty += 1;
      return;
    }

    if (plan.method === 'subtract') result.snapshotsSubtracted += 1;
    if (plan.method === 'fold-in') result.snapshotsFoldedIn += 1;
    if (plan.method === 'rebuild') result.snapshotsRebuilt += 1;

    result.unpricedPositionCount += rebuilt.positions.filter(
      (position) => position.priceUsd === null && position.kind !== 'exchange' && position.kind !== 'manual',
    ).length;

    const totalUsd = rebuilt.positions.reduce((total, position) => total + position.valueUsd, 0);
    if (Math.abs(totalUsd - plan.snapshot.totalUsd) > 0.005) result.snapshotsChanged += 1;

    preview.push({
      timestamp: plan.snapshot.timestamp,
      totalUsdBefore: plan.snapshot.totalUsd,
      totalUsdAfter: totalUsd,
      method: plan.method as WalletScopeMethod,
    });

    updated.push({
      ...plan.snapshot,
      totalUsd,
      positions: rebuilt.positions,
      scope: current,
      attributedOwners: rebuilt.attributedOwners,
    });

    options.onProgress?.({ phase: 'updating-snapshots', completed: index + 1, total: drifted.length });
  });

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

  const attributed = new Set(snapshot.attributedOwners ?? []);
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

  // Already measuring what the app measures. Nothing to do, and deliberately not restamped: rewriting a row
  // to record an inference as though it were observed would turn a guess into a claim.
  if (scopeMatches(measured, current)) return plan;

  // The chain axis moved without the wallets moving. Replaying is the only way to apply that.
  return { ...plan, method: 'rebuild' };
};

interface OwnerReplay {
  balanceSeries: Map<string, BalanceSeries>;
  amountByOwnerByKey: Map<string, Array<Record<string, number>>>;
  nftSeries: Map<string, NftSeries>;
  nftCountByOwnerByKey: Map<string, Array<Record<string, number>>>;
  chainsWithoutArchiveState: number[];
}

// Replays a set of wallets over a set of moments, keeping each wallet's contribution separate.
//
// Per owner rather than all at once, for two reasons. It is what makes the result attributable, so a wallet
// folded in today can be taken back out tomorrow by arithmetic. And it fixes a real defect in the combined
// replay: the series builder groups events by contract with the owner absent from the key and clamps the
// combined running balance at zero, so one wallet's unmatched outbound transfer can cancel another wallet's
// genuine holding. Replayed separately, each wallet is clamped alone.
const replayOwners = async (
  timestamps: number[],
  owners: string[],
  dustThresholdAmount: number,
  onProgress?: (progress: WalletScopeProgress) => void,
): Promise<OwnerReplay> => {
  const lowercaseOwners = normaliseOwners(owners);

  const [events, balances, cursors, settings, collectionNames] = await Promise.all([
    db.transferEvents.where('owner').anyOf(lowercaseOwners).toArray(),
    db.balances.where('owner').anyOf(lowercaseOwners).toArray(),
    db.syncCursors.where('owner').anyOf(lowercaseOwners).toArray(),
    loadSettings(),
    getCollectionNames(),
  ]);

  // Every chain these wallets have touched, from three sources because no one of them is complete: events
  // miss a chain where only the native coin was ever held, balances are deleted when they reach zero, and
  // cursors record every chain that was ever synced for the wallet.
  const isChainEnabled = createEnabledChainFilter(settings.sync);
  const chainIds = deduplicateArray([
    ...events.map((event) => event.chainId),
    ...balances.map((balance) => balance.chainId),
    ...cursors.map((cursor) => cursor.chainId),
  ]).filter(isChainEnabled);

  const blocksByChain = await resolveBlocksForTimestamps(chainIds, timestamps, (completed, total) =>
    onProgress?.({ phase: 'resolving-blocks', completed, total }),
  );

  const tokensById = new Map((await db.tokens.toArray()).map((token) => [token.id, token]));

  const balanceSeries = new Map<string, BalanceSeries>();
  const amountByOwnerByKey = new Map<string, Array<Record<string, number>>>();
  const nftSeries = new Map<string, NftSeries>();
  const nftCountByOwnerByKey = new Map<string, Array<Record<string, number>>>();
  const chainsWithoutArchiveState: number[] = [];

  let completedOwners = 0;

  await mapAsyncBounded(lowercaseOwners, OWNER_REPLAY_CONCURRENCY, async (owner) => {
    const ownerEvents = events.filter((event) => event.owner === owner);

    const ownerBalances = buildTokenBalanceSeries(
      ownerEvents.filter((event) => event.standard === 'erc20'),
      timestamps,
      blocksByChain,
      tokensById,
    );

    // Native holdings emit no logs, so they come from historical chain state rather than from the replay.
    const native = await readHistoricalNativeBalances(chainIds, [getAddress(owner)], timestamps, blocksByChain).catch(
      () => ({ series: [], chainsWithoutArchiveAccess: chainIds }),
    );
    for (const series of native.series) mergeNativeBalanceSeries(ownerBalances, series);
    chainsWithoutArchiveState.push(...native.chainsWithoutArchiveAccess);

    for (const [priceKey, series] of ownerBalances) {
      mergeSeries(balanceSeries, priceKey, series, timestamps.length);
      recordSplit(amountByOwnerByKey, priceKey, owner, series.amounts, timestamps.length, dustThresholdAmount);
    }

    const ownerNfts = buildNftPositionSeries(ownerEvents, timestamps, blocksByChain, collectionNames);
    for (const [collectionKey, series] of ownerNfts) {
      const existing = nftSeries.get(collectionKey);
      if (existing) {
        existing.counts = existing.counts.map((count, index) => count + (series.counts[index] ?? 0));
      } else {
        nftSeries.set(collectionKey, { ...series, counts: [...series.counts] });
      }

      recordSplit(nftCountByOwnerByKey, collectionKey, owner, series.counts, timestamps.length, 1);
    }

    completedOwners += 1;
    onProgress?.({
      phase: 'reading-native-balances',
      completed: completedOwners,
      total: lowercaseOwners.length,
    });
  });

  return {
    balanceSeries,
    amountByOwnerByKey,
    nftSeries,
    nftCountByOwnerByKey,
    chainsWithoutArchiveState: deduplicateArray(chainsWithoutArchiveState),
  };
};

const mergeSeries = (target: Map<string, BalanceSeries>, key: string, series: BalanceSeries, length: number): void => {
  const existing = target.get(key);

  if (existing) {
    existing.amounts = existing.amounts.map((amount, index) => amount + (series.amounts[index] ?? 0));
    return;
  }

  target.set(key, { symbol: series.symbol, amounts: Array.from({ length }, (_, index) => series.amounts[index] ?? 0) });
};

const recordSplit = (
  target: Map<string, Array<Record<string, number>>>,
  key: string,
  owner: string,
  amounts: number[],
  length: number,
  minimum: number,
): void => {
  const existing = target.get(key) ?? Array.from({ length }, () => ({}) as Record<string, number>);

  amounts.forEach((amount, index) => {
    if (amount < minimum) return;
    existing[index] = { ...existing[index], [owner]: (existing[index][owner] ?? 0) + amount };
  });

  target.set(key, existing);
};

// The key a replayed holding is recorded under.
//
// The replay works in price keys and a snapshot is written in identity keys, and the two disagree for
// exactly the assets CoinGecko lists: `coingecko:ethereum` and `1:0xa0b8...` both become `coin:...`.
// Canonicalising here, at the write boundary rather than inside the replay, is what keeps the pricing
// helpers working on the key shape they were written for.
const canonicalKeyFor = (priceKey: string, tokensById: Map<string, StoredToken>): string => {
  if (priceKey.startsWith('coingecko:')) return `coin:${priceKey.slice('coingecko:'.length)}`;

  const token = tokensById.get(priceKey);
  if (token?.coingeckoId) return `coin:${token.coingeckoId}`;

  return priceKey;
};

// A price for every canonical key at every moment, taken from the snapshots themselves wherever they have
// one and asked about only where they do not.
//
// Carry-over is the primary source rather than a fallback, and it is both cheaper and more accurate. A
// recorded price is a spot price captured at that moment; the historical replacement is one bucketed point
// per UTC day carried forward, and for a token only quoted on a DEX there is no series at all. Fetching is
// left for genuinely new assets, which is nothing at all for a pure removal.
const resolvePrices = async (
  replays: Array<OwnerReplay | undefined>,
  plans: SnapshotPlan[],
  tokensById: Map<string, StoredToken>,
  onProgress?: (progress: WalletScopeProgress) => void,
): Promise<Map<string, HistoricalPriceSeries>> => {
  const recordedKeys = new Set(plans.flatMap((plan) => plan.snapshot.positions.map((position) => position.priceKey)));

  const residualKeys = deduplicateArray(
    replays
      .filter((replay): replay is OwnerReplay => replay !== undefined)
      .flatMap((replay) => [...replay.balanceSeries.keys()])
      .map((priceKey) => canonicalKeyFor(priceKey, tokensById))
      .filter((key) => !recordedKeys.has(key)),
  );

  const seriesByKey = new Map<string, HistoricalPriceSeries>();
  if (residualKeys.length === 0) return seriesByKey;

  const timestamps = plans.map((plan) => plan.snapshot.timestamp);
  const window: HistoryWindow = {
    from: Math.min(...timestamps),
    to: Math.max(...timestamps),
    truncated: false,
  };

  let completed = 0;
  onProgress?.({ phase: 'fetching-prices', completed, total: residualKeys.length });

  await mapAsyncBounded(residualKeys, PRICE_FETCH_CONCURRENCY, async (key) => {
    const series = await fetchSeriesForCanonicalKey(key, window, tokensById).catch(() => undefined);
    if (series) seriesByKey.set(key, series);

    completed += 1;
    onProgress?.({ phase: 'fetching-prices', completed, total: residualKeys.length });
  });

  return seriesByKey;
};

const fetchSeriesForCanonicalKey = async (
  key: string,
  window: HistoryWindow,
  tokensById: Map<string, StoredToken>,
): Promise<HistoricalPriceSeries | undefined> => {
  if (key.startsWith('coin:')) {
    return fetchHistoricalSeriesForCoin(key.slice('coin:'.length), key, window);
  }

  // Anything else is a contract the coin list has never carried, so it can only be asked about by address.
  const token = tokensById.get(key);
  if (!token) return undefined;

  return fetchHistoricalSeriesForContract(token.chainId, token.address, key, window);
};

// Assembles one snapshot's new positions. Returns undefined when the result would be an empty point.
const buildPositions = (
  plan: SnapshotPlan,
  replay: OwnerReplay | undefined,
  timestampIndex: number,
  tokensById: Map<string, StoredToken>,
  historicalPrices: Map<string, HistoricalPriceSeries>,
  dustThresholdAmount: number,
): { positions: SnapshotPosition[]; attributedOwners: string[] } | undefined => {
  const recordedOnChain = plan.snapshot.positions.filter(
    (position) => position.kind === 'token' || position.kind === 'nft',
  );
  const kept = plan.snapshot.positions.filter((position) => position.kind === 'exchange' || position.kind === 'manual');

  const attributedOwners = normaliseOwners([
    ...(plan.snapshot.attributedOwners ?? []).filter((owner) => !plan.removed.includes(owner)),
    ...plan.added,
  ]);

  if (plan.method === 'subtract') {
    const positions = subtractOwners(recordedOnChain, plan.removableNow, dustThresholdAmount);
    if (recordedOnChain.length > 0 && positions.length === 0) return undefined;

    return { positions: [...positions, ...kept], attributedOwners };
  }

  if (!replay || timestampIndex < 0) return undefined;

  // Everything the replayed wallets held at this moment, in the snapshot's own key space.
  const replayed = new Map<
    string,
    { symbol: string; amount: number; owners: Record<string, number>; kind: 'token' | 'nft' }
  >();

  for (const [priceKey, series] of replay.balanceSeries) {
    const amount = series.amounts[timestampIndex] ?? 0;
    if (amount < dustThresholdAmount) continue;

    const key = canonicalKeyFor(priceKey, tokensById);
    const owners = replay.amountByOwnerByKey.get(priceKey)?.[timestampIndex] ?? {};
    const existing = replayed.get(key);

    // Several contracts can collapse onto one identity, which is exactly how a recorded snapshot writes one
    // USDC row spanning five chains.
    if (existing) {
      existing.amount += amount;
      for (const [owner, ownerAmount] of Object.entries(owners)) {
        existing.owners[owner] = (existing.owners[owner] ?? 0) + ownerAmount;
      }
    } else {
      replayed.set(key, { symbol: series.symbol, amount, owners: { ...owners }, kind: 'token' });
    }
  }

  for (const [collectionKey, series] of replay.nftSeries) {
    const count = series.counts[timestampIndex] ?? 0;
    if (count === 0) continue;

    replayed.set(collectionKey, {
      symbol: series.name,
      amount: count,
      owners: replay.nftCountByOwnerByKey.get(collectionKey)?.[timestampIndex] ?? {},
      kind: 'nft',
    });
  }

  const base =
    plan.method === 'rebuild'
      ? []
      : // Folding in strips the added wallets' previous contribution first, so a second run converges on the
        // same answer rather than counting them twice.
        subtractOwners(recordedOnChain, plan.added, dustThresholdAmount);

  const positions = new Map(base.map((position) => [`${position.kind}:${position.priceKey}`, { ...position }]));

  for (const [key, holding] of replayed) {
    const positionKey = `${holding.kind}:${key}`;
    const existing = positions.get(positionKey);

    const priceUsd =
      existing?.priceUsd ??
      recordedPriceFor(plan.snapshot, key, holding.kind) ??
      priceAt(historicalPrices.get(key) ?? { priceKey: key, points: [] }, plan.snapshot.timestamp);

    const amount = (existing?.amount ?? 0) + holding.amount;

    positions.set(positionKey, {
      priceKey: key,
      symbol: existing?.symbol ?? holding.symbol,
      amount,
      priceUsd,
      valueUsd: priceUsd === null ? 0 : amount * priceUsd,
      kind: holding.kind,
      amountByOwner: { ...(existing?.amountByOwner ?? {}), ...holding.owners },
    });
  }

  const rebuilt = [...positions.values()].filter((position) => position.amount >= dustThresholdAmount);
  if (recordedOnChain.length > 0 && rebuilt.length === 0) return undefined;

  return { positions: [...rebuilt, ...kept], attributedOwners };
};

// The price this snapshot already recorded for an asset, which is a spot price captured at that moment and
// therefore better than anything a daily historical series can offer.
const recordedPriceFor = (snapshot: StoredSnapshot, key: string, kind: 'token' | 'nft'): number | null | undefined =>
  snapshot.positions.find((position) => position.kind === kind && position.priceKey === key)?.priceUsd;

// Written only where the row is still the one that was read.
//
// A run takes minutes, and in that time the History page's delete button is live, a sync can end with a new
// snapshot, and the manual reprocess can rewrite the same rows. Checking existence stops a deleted point
// being resurrected; checking `createdAt` stops another writer's version being overwritten by one computed
// from positions that are now stale.
const writeIfUnchanged = async (updated: StoredSnapshot[], plans: SnapshotPlan[]): Promise<void> => {
  if (updated.length === 0) return;

  const baselineCreatedAt = new Map(plans.map((plan) => [plan.snapshot.timestamp, plan.snapshot.createdAt]));

  await db.transaction('rw', db.snapshots, async () => {
    const existing = await db.snapshots.bulkGet(updated.map((snapshot) => snapshot.timestamp));

    const safe = updated.filter((snapshot, index) => {
      const current = existing[index];
      return current !== undefined && current.createdAt === baselineCreatedAt.get(snapshot.timestamp);
    });

    if (safe.length > 0) await db.snapshots.bulkPut(safe);
  });
};

const getCollectionNames = async (): Promise<Map<string, string>> => {
  const collections = await db.nftCollections.toArray();

  return new Map(
    collections.map((collection) => [collection.id, collection.name ?? collection.symbol ?? collection.address]),
  );
};
