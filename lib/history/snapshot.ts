import { db } from 'lib/db';
import type { SnapshotPosition, SnapshotScope, StoredSnapshot } from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';
import { splitNftPositionsByOwner, splitTokenPositionsByOwner } from 'lib/history/attribution';
import { normaliseOwners } from 'lib/history/scope';
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
  const source = await loadPortfolioSource();
  const input = buildAggregationInput(source);

  const tokens = aggregateTokens(input).filter((token) => !token.isHidden);
  const nftCollections = aggregateNftCollections(input).filter((collection) => !collection.isHidden);

  // Which wallet contributed what, split out of the same rows the totals were built from.
  //
  // Free to compute here and impossible to recover later: once the amounts are summed, a wallet cannot be
  // taken back out of the figure. Recording the split is what lets a wallet be removed from this point by
  // arithmetic rather than by replaying its history from stored events.
  const tokenSplits = splitTokenPositionsByOwner(tokens, input);
  const nftSplits = splitNftPositionsByOwner(nftCollections);

  const positions = [...buildTokenPositions(tokens, tokenSplits), ...buildNftPositions(nftCollections, nftSplits)];

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
    // Stamped with the set this point was measured over, which the writer knows exactly because it just
    // measured it. Without the stamp a later run has to infer it from when each wallet was added.
    scope: await currentScopeFor(source),
    // Every wallet that was measured, not only those that turned out to hold something. A wallet holding
    // nothing appears in no split, and reading that as "not attributed" would have it folded in again on
    // every future run.
    attributedOwners: normaliseOwners((source.wallets ?? []).map((wallet) => wallet.address)),
  };

  await db.snapshots.put(snapshot);
  return snapshot;
};

// The scope the writer just measured, built from the source it aggregated rather than from a second read,
// so the stamp cannot describe a different moment than the figures beside it.
const currentScopeFor = async (source: Awaited<ReturnType<typeof loadPortfolioSource>>): Promise<SnapshotScope> => {
  const { sync } = await loadSettings();

  return {
    wallets: normaliseOwners((source.wallets ?? []).map((wallet) => wallet.address)),
    chainIds: sync.enabledChainIds,
    includeTestnets: sync.includeTestnets,
  };
};

// One position per asset per kind of place it is held.
//
// A row can now span chains and exchanges at once, and the split is kept rather than flattened so a
// snapshot still says how much was on-chain and how much sat on an exchange.
export const buildTokenPositions = (
  tokens: ReturnType<typeof aggregateTokens>,
  splitsByKey: Map<string, Record<string, number>> = new Map(),
): SnapshotPosition[] =>
  tokens.flatMap((token) => {
    const positions: SnapshotPosition[] = [];

    const chainAmount = sumLocationAmounts(token, 'chain');
    const exchangeAmount = sumLocationAmounts(token, 'exchange');
    const manualAmount = sumLocationAmounts(token, 'manual');

    if (chainAmount > 0) {
      positions.push({
        priceKey: token.key,
        symbol: token.symbol,
        amount: chainAmount,
        priceUsd: token.priceUsd,
        valueUsd: token.chainValueUsd,
        kind: 'token',
        amountByOwner: splitsByKey.get(token.key),
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

    if (manualAmount > 0) {
      positions.push({
        priceKey: token.key,
        symbol: token.symbol,
        amount: manualAmount,
        priceUsd: token.priceUsd,
        valueUsd: token.manualValueUsd,
        kind: 'manual',
      });
    }

    return positions;
  });

const sumLocationAmounts = (
  token: ReturnType<typeof aggregateTokens>[number],
  kind: 'chain' | 'exchange' | 'manual',
): number =>
  token.locations.filter((location) => location.kind === kind).reduce((total, location) => total + location.amount, 0);

export const buildNftPositions = (
  collections: ReturnType<typeof aggregateNftCollections>,
  splitsByKey: Map<string, Record<string, number>> = new Map(),
): SnapshotPosition[] =>
  collections.map((collection) => ({
    priceKey: collection.key,
    symbol: collection.name,
    amount: collection.itemCount,
    priceUsd: collection.floorPriceUsd,
    valueUsd: collection.valueUsd ?? 0,
    kind: 'nft' as const,
    amountByOwner: splitsByKey.get(collection.key),
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

// The current UTC time of day, for a field that means "when did this happen" rather than "which moment do I
// want measured". Defaulting a ledger entry to 09:00 would date it in the future for anyone filling the
// form before then, and a future-dated entry counts towards nothing.
export const currentUtcTimeInput = (timestamp: number = Date.now()): string =>
  new Date(timestamp).toISOString().slice(11, 16);
