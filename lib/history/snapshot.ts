import { db } from 'lib/db';
import type { SnapshotPosition, StoredSnapshot } from 'lib/db/schema';
import { aggregateNftCollections, aggregateTokens, calculateTotals } from 'lib/portfolio/aggregate';
import { buildAggregationInput, loadPortfolioSource } from 'lib/portfolio/load';

// Records what the portfolio is worth right now.
//
// This is the accurate half of the history. Balances have just been read from the chain and prices have
// just been fetched, so nothing here is reconstructed or inferred: the point it writes is exactly the
// figure the dashboard is showing at that moment, because both come from the same aggregation.
//
// Returns the snapshot it wrote, or undefined when there was nothing to record.
export const recordCurrentSnapshot = async (timestamp: number = Date.now()): Promise<StoredSnapshot | undefined> => {
  const input = buildAggregationInput(await loadPortfolioSource());

  const tokens = aggregateTokens(input).filter((token) => !token.isHidden);
  const nftCollections = aggregateNftCollections(input).filter((collection) => !collection.isHidden);

  const positions = [...buildTokenPositions(tokens), ...buildNftPositions(nftCollections)];

  // An empty portfolio is not a portfolio worth zero. A first sync that failed everywhere looks exactly
  // like this, and recording it would put a false zero on the chart that the user cannot tell from a real
  // one. Nothing to record is nothing to record.
  if (positions.length === 0) return undefined;

  const totals = calculateTotals(tokens, nftCollections);

  const snapshot: StoredSnapshot = {
    timestamp,
    totalUsd: totals.totalUsd,
    createdAt: Date.now(),
    positions,
  };

  await db.snapshots.put(snapshot);
  return snapshot;
};

// One position per asset per kind of place it is held.
//
// A row can now span chains and exchanges at once, and the split is kept rather than flattened so a
// snapshot still says how much was on-chain and how much sat on an exchange.
export const buildTokenPositions = (tokens: ReturnType<typeof aggregateTokens>): SnapshotPosition[] =>
  tokens.flatMap((token) => {
    const positions: SnapshotPosition[] = [];

    const chainAmount = sumLocationAmounts(token, 'chain');
    const exchangeAmount = sumLocationAmounts(token, 'exchange');

    if (chainAmount > 0) {
      positions.push({
        priceKey: token.key,
        symbol: token.symbol,
        amount: chainAmount,
        priceUsd: token.priceUsd,
        valueUsd: token.chainValueUsd,
        kind: 'token',
      });
    }

    if (exchangeAmount > 0) {
      positions.push({
        priceKey: token.key,
        symbol: token.symbol,
        amount: exchangeAmount,
        priceUsd: token.priceUsd,
        valueUsd: token.exchangeValueUsd,
        kind: 'exchange',
      });
    }

    return positions;
  });

const sumLocationAmounts = (token: ReturnType<typeof aggregateTokens>[number], kind: 'chain' | 'exchange'): number =>
  token.locations.filter((location) => location.kind === kind).reduce((total, location) => total + location.amount, 0);

export const buildNftPositions = (collections: ReturnType<typeof aggregateNftCollections>): SnapshotPosition[] =>
  collections.map((collection) => ({
    priceKey: collection.key,
    symbol: collection.name,
    amount: collection.itemCount,
    priceUsd: collection.floorPriceUsd,
    valueUsd: collection.valueUsd ?? 0,
    kind: 'nft' as const,
  }));

export const deleteSnapshot = async (timestamp: number): Promise<void> => {
  await db.snapshots.delete(timestamp);
};

// The default time of day offered when adding a snapshot by hand. After the daily price feeds have settled,
// and the same for every point, so manually added snapshots stay comparable to each other.
export const DEFAULT_SNAPSHOT_TIME_UTC = '09:00';

// Turns the date and time fields into the moment they name in UTC.
//
// Built with Date.UTC rather than `new Date('2026-08-22T09:00')`, which a browser reads as local time. The
// difference is silent, is worth hours, and would put a snapshot on the wrong side of a day boundary for
// anyone east or west of Greenwich.
export const snapshotTimestampFromUtcInput = (date: string, time: string): number | null => {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);

  if ([year, month, day, hour, minute].some((part) => !Number.isFinite(part))) return null;

  return Date.UTC(year, month - 1, day, hour, minute);
};

// The value a `type="date"` input expects, for a moment expressed in UTC.
export const toUtcDateInputValue = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);
