import { db } from 'lib/db';
import { coingeckoPriceKey } from 'lib/db/keys';
import type { StoredSnapshot } from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';
import { amountAt, groupEntriesByBalance } from 'lib/manual/balances';
import { computeSnapshotTotalUsd } from 'lib/portfolio/snapshot-lens';
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
  // Holdings that were held at a snapshot but had no price there, and so contributed nothing.
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
//   - It never touches anything but the manual rows and their coins' prices. Balances read from the chain
//     at the time are facts a replay could only degrade. A price a snapshot already has is kept for the
//     same reason: it was captured at the moment, and the historical series is one point per day.
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

  for (const [index, snapshot] of snapshots.entries()) {
    const manualHoldings: StoredSnapshot['manualHoldings'] = [];
    const prices = new Map((snapshot.prices ?? []).map((price) => [price.id, price.priceUsd]));

    for (const balance of balances) {
      const amount = amountAt(entriesByBalance.get(balance.id) ?? [], snapshot.timestamp);
      if (amount < spam.dustThresholdAmount) continue;

      manualHoldings.push({
        balanceId: balance.id,
        symbol: balance.symbol,
        coingeckoId: balance.coingeckoId,
        location: balance.location,
        wallet: balance.wallet,
        amount,
      });

      if (!balance.coingeckoId) continue;

      // The price this snapshot already recorded wins; the historical series only fills gaps, for points
      // that never priced this coin. A previously stored null is asked about again: it was a question
      // without an answer, not an answer.
      const priceId = coingeckoPriceKey(balance.coingeckoId);
      const recorded = prices.get(priceId);
      if (typeof recorded === 'number') continue;

      const series = seriesByCoinId.get(balance.coingeckoId);
      const priceUsd = series ? priceAt(series, snapshot.timestamp) : null;
      prices.set(priceId, priceUsd);
      if (priceUsd === null) unpricedPositionCount += 1;
    }

    const candidate: StoredSnapshot = {
      ...snapshot,
      manualHoldings,
      prices: [...prices.entries()].map(([id, priceUsd]) => ({ id, priceUsd })),
    };

    // Written back only when something actually differs, so a run that changes nothing leaves every row
    // alone rather than churning the database and the live queries watching it.
    if (isUnchanged(snapshot, candidate)) continue;

    candidate.totalUsd = await computeSnapshotTotalUsd(candidate);

    snapshotsChanged += 1;
    positionsWritten += manualHoldings.length;
    updated.push(candidate);

    onProgress?.({ phase: 'updating-snapshots', completed: index + 1, total: snapshots.length });
  }

  if (updated.length > 0) await writeIfUnchanged(updated, snapshots);

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

const isUnchanged = (before: StoredSnapshot, after: StoredSnapshot): boolean => {
  const holdingKey = (holding: StoredSnapshot['manualHoldings'][number]) =>
    `${holding.balanceId}:${holding.amount}:${holding.coingeckoId ?? ''}:${holding.location}:${holding.wallet ?? ''}`;
  const priceKey = (price: StoredSnapshot['prices'][number]) => `${price.id}:${price.priceUsd}`;

  const beforeHoldings = new Set((before.manualHoldings ?? []).map(holdingKey));
  const afterHoldings = (after.manualHoldings ?? []).map(holdingKey);
  const beforePrices = new Set((before.prices ?? []).map(priceKey));
  const afterPrices = (after.prices ?? []).map(priceKey);

  return (
    beforeHoldings.size === afterHoldings.length &&
    afterHoldings.every((key) => beforeHoldings.has(key)) &&
    beforePrices.size === afterPrices.length &&
    afterPrices.every((key) => beforePrices.has(key))
  );
};

// Written only where the row is still the one that was read: a sync can end mid-run, and the History
// page's delete button is live throughout. Existence stops a deleted point being resurrected; createdAt
// stops another writer's version being overwritten from stale rows.
const writeIfUnchanged = async (updated: StoredSnapshot[], readSnapshots: StoredSnapshot[]): Promise<void> => {
  const baselineCreatedAt = new Map(readSnapshots.map((snapshot) => [snapshot.timestamp, snapshot.createdAt]));

  await db.transaction('rw', db.snapshots, async () => {
    const existing = await db.snapshots.bulkGet(updated.map((snapshot) => snapshot.timestamp));

    const safe = updated.filter((snapshot, index) => {
      const current = existing[index];
      return current !== undefined && current.createdAt === baselineCreatedAt.get(snapshot.timestamp);
    });

    if (safe.length > 0) await db.snapshots.bulkPut(safe);
  });
};
