import { db } from 'lib/db';
import { coingeckoPriceKey } from 'lib/db/keys';
import type { SnapshotPosition, StoredSnapshot } from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';
import { amountAt, groupEntriesByBalance } from 'lib/manual/balances';
import {
  fetchHistoricalSeriesForCoin,
  type HistoricalPriceSeries,
  priceAt,
  resolveEarliestPricedTimestamp,
} from 'lib/prices/historical';
import { mapAsyncBounded } from 'lib/utils/promises';

export interface ManualReprocessProgress {
  phase: 'fetching-prices' | 'updating-snapshots';
  completed: number;
  total: number;
}

export interface ManualReprocessResult {
  status: 'updated' | 'no-snapshots';
  snapshotsExamined: number;
  snapshotsChanged: number;
  // Manual holdings written across every snapshot, which is a count of facts recorded rather than of assets.
  positionsWritten: number;
  // Holdings that were held at a snapshot but had no historical price there, and so contributed nothing.
  unpricedPositionCount: number;
  // Set when snapshots reach further back than the configured CoinGecko plan will price.
  earliestPricedTimestamp?: number;
}

const PRICE_FETCH_CONCURRENCY = 3;

// Folds manual balances into the snapshots that already exist.
//
// Adding a manual balance today says nothing about the history already recorded: those points were taken
// before the app knew the holding existed, so they are missing it. This replays each balance's ledger
// against every snapshot's moment and writes the result back into it.
//
// Two things it deliberately does not do:
//
//   - It never creates a snapshot. Which moments are worth recording is the user's decision, and inventing
//     points here would put figures on the chart they never asked for.
//   - It never touches a non-manual position. A point recorded at sync time holds balances read from the
//     chain, which is more accurate than anything a reconstruction could produce; rebuilding those would
//     trade a fact for an estimate. Only the `manual` positions are replaced, so running this repeatedly
//     converges rather than accumulating.
export const reprocessManualBalances = async (
  onProgress?: (progress: ManualReprocessProgress) => void,
): Promise<ManualReprocessResult> => {
  const snapshots = await db.snapshots.orderBy('timestamp').toArray();

  if (snapshots.length === 0) {
    return {
      status: 'no-snapshots',
      snapshotsExamined: 0,
      snapshotsChanged: 0,
      positionsWritten: 0,
      unpricedPositionCount: 0,
    };
  }

  // Disabled balances are left out, exactly as they are everywhere else that counts money. Their ledgers
  // stay untouched, so re-enabling one and running this again brings it back.
  const { spam } = await loadSettings();
  const balances = await db.manualBalances.where('enabled').equals(1).toArray();
  const entriesByBalance = groupEntriesByBalance(await db.manualLedger.toArray());

  const earliestPriced = await resolveEarliestPricedTimestamp();
  const seriesByCoinId = await fetchSeriesForBalances(balances, snapshots, earliestPriced, onProgress);

  let snapshotsChanged = 0;
  let positionsWritten = 0;
  let unpricedPositionCount = 0;

  const updated: StoredSnapshot[] = [];

  snapshots.forEach((snapshot, index) => {
    const manualPositions: SnapshotPosition[] = [];

    for (const balance of balances) {
      const amount = amountAt(entriesByBalance.get(balance.id) ?? [], snapshot.timestamp);
      if (amount < spam.dustThresholdAmount) continue;

      const series = balance.coingeckoId ? seriesByCoinId.get(balance.coingeckoId) : undefined;
      const priceUsd = series ? priceAt(series, snapshot.timestamp) : null;

      if (priceUsd === null) unpricedPositionCount += 1;

      manualPositions.push({
        priceKey: `manual:${balance.id}`,
        symbol: balance.symbol,
        amount,
        priceUsd,
        valueUsd: priceUsd === null ? 0 : amount * priceUsd,
        kind: 'manual',
      });
    }

    const others = snapshot.positions.filter((position) => position.kind !== 'manual');
    const positions = [...others, ...manualPositions];

    // Written back only when it actually differs, so a run that changes nothing leaves every row alone
    // rather than churning the database and the live queries watching it.
    if (isUnchanged(snapshot.positions, positions)) return;

    snapshotsChanged += 1;
    positionsWritten += manualPositions.length;

    updated.push({
      ...snapshot,
      totalUsd: positions.reduce((total, position) => total + position.valueUsd, 0),
      positions,
    });

    onProgress?.({ phase: 'updating-snapshots', completed: index + 1, total: snapshots.length });
  });

  if (updated.length > 0) await db.snapshots.bulkPut(updated);

  return {
    status: 'updated',
    snapshotsExamined: snapshots.length,
    snapshotsChanged,
    positionsWritten,
    unpricedPositionCount,
    earliestPricedTimestamp:
      earliestPriced !== null && snapshots[0].timestamp < earliestPriced ? earliestPriced : undefined,
  };
};

// One price series per coin, covering every snapshot at once.
//
// The range is the whole history rather than a window per snapshot, so a hundred points cost one request
// per coin instead of a hundred. `priceAt` then picks the right point out of it for each moment.
const fetchSeriesForBalances = async (
  balances: Array<{ coingeckoId?: string }>,
  snapshots: StoredSnapshot[],
  earliestPriced: number | null,
  onProgress?: (progress: ManualReprocessProgress) => void,
): Promise<Map<string, HistoricalPriceSeries>> => {
  const coingeckoIds = [
    ...new Set(balances.map((balance) => balance.coingeckoId).filter((id): id is string => Boolean(id))),
  ];

  const seriesByCoinId = new Map<string, HistoricalPriceSeries>();
  if (coingeckoIds.length === 0) return seriesByCoinId;

  const window = {
    // Clamped to what the plan will serve: asking for more is refused outright rather than answered with
    // the part it is willing to give.
    from: Math.max(snapshots[0].timestamp, earliestPriced ?? Number.NEGATIVE_INFINITY),
    to: snapshots[snapshots.length - 1].timestamp,
    truncated: false,
  };

  let completed = 0;
  onProgress?.({ phase: 'fetching-prices', completed, total: coingeckoIds.length });

  await mapAsyncBounded(coingeckoIds, PRICE_FETCH_CONCURRENCY, async (coingeckoId) => {
    const series = await fetchHistoricalSeriesForCoin(coingeckoId, coingeckoPriceKey(coingeckoId), window).catch(
      () => undefined,
    );

    if (series) seriesByCoinId.set(coingeckoId, series);

    completed += 1;
    onProgress?.({ phase: 'fetching-prices', completed, total: coingeckoIds.length });
  });

  return seriesByCoinId;
};

const isUnchanged = (before: SnapshotPosition[], after: SnapshotPosition[]): boolean => {
  if (before.length !== after.length) return false;

  const key = (position: SnapshotPosition) =>
    `${position.kind}:${position.priceKey}:${position.amount}:${position.valueUsd}`;
  const beforeKeys = new Set(before.map(key));

  return after.every((position) => beforeKeys.has(key(position)));
};
