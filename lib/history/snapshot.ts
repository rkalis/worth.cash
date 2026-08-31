import { db } from 'lib/db';
import type { SnapshotScope, StoredSnapshot } from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';
import { normaliseOwners } from 'lib/history/scope';
import { type AggregationInput, calculateTotals } from 'lib/portfolio/aggregate';
import { assemblePortfolio } from 'lib/portfolio/assemble';
import { buildAggregationInput, loadPortfolioSource } from 'lib/portfolio/load';

// Records what the portfolio is right now: not a rendered summary, but the aggregation's own input,
// frozen. A pinned snapshot later feeds these rows back through the same aggregation the dashboard runs,
// which is what makes the historical view exact rather than approximate: same code, older facts.
//
// Returns the snapshot it wrote, or undefined when there was nothing to record.
export const recordCurrentSnapshot = async (timestamp: number = Date.now()): Promise<StoredSnapshot | undefined> => {
  const source = await loadPortfolioSource();
  const input = buildAggregationInput(source);

  const facts = buildSnapshotFacts(input);

  // An empty portfolio is not a portfolio worth zero. A first sync that failed everywhere looks exactly
  // like this, and recording it would put a false zero on the chart that the user cannot tell from a real
  // one. Nothing to record is nothing to record.
  const holdsAnything =
    facts.balances.length > 0 ||
    facts.nftHoldings.length > 0 ||
    facts.exchangeBalances.length > 0 ||
    facts.manualHoldings.length > 0;
  if (!holdsAnything) return undefined;

  const { tokens, nftCollections } = assemblePortfolio(input);

  const snapshot: StoredSnapshot = {
    timestamp,
    totalUsd: calculateTotals(tokens, nftCollections).totalUsd,
    createdAt: Date.now(),
    ...facts,
    // Stamped with the set this point was measured over, which the writer knows exactly because it just
    // measured it. Without the stamp a later run has to infer it from when each wallet was added.
    scope: await currentScopeFor(source),
    // Every wallet that was measured, not only those that held something: the rows carry their owners,
    // but a wallet holding nothing appears on no row, and forgetting it was measured would have it
    // re-measured forever.
    attributedOwners: normaliseOwners((source.wallets ?? []).map((wallet) => wallet.address)),
  };

  await db.snapshots.put(snapshot);
  return snapshot;
};

// The facts a snapshot stores, cut from the aggregation input it was measured with.
//
// The input is already filtered the way the dashboard filters (enabled chains, enabled accounts, enabled
// manual balances), so what is frozen is exactly what was measured. Metadata is trimmed to what valuing
// and labelling need; logos stay live-only, prices are trimmed to the keys the held assets can be priced
// under, and nothing derived is stored.
export const buildSnapshotFacts = (
  input: AggregationInput,
): Pick<
  StoredSnapshot,
  | 'balances'
  | 'tokens'
  | 'prices'
  | 'nftCollections'
  | 'nftHoldings'
  | 'exchangeBalances'
  | 'exchangeAccounts'
  | 'exchangeAssetCoingeckoIds'
  | 'manualHoldings'
  | 'fiatRatesPerUsd'
> => {
  const heldTokenIds = new Set(input.balances.map((balance) => `${balance.chainId}:${balance.token}`));
  const tokens = input.tokens.filter((token) => heldTokenIds.has(token.id));

  // Every key a held asset could be priced under: its own contract, its coin id, an exchange asset's
  // resolved coin, and a manual holding's coin.
  const relevantPriceKeys = new Set<string>();
  for (const token of tokens) {
    relevantPriceKeys.add(token.id);
    if (token.coingeckoId) relevantPriceKeys.add(`coingecko:${token.coingeckoId}`);
  }
  for (const coingeckoId of Object.values(input.exchangeAssetCoingeckoIds)) {
    relevantPriceKeys.add(`coingecko:${coingeckoId}`);
  }
  for (const holding of input.manualHoldings ?? []) {
    if (holding.balance.coingeckoId) relevantPriceKeys.add(`coingecko:${holding.balance.coingeckoId}`);
  }

  const heldCollectionIds = new Set(input.nftItems.map((item) => `${item.chainId}:${item.collection}`));

  // Item rows collapse to one count per (collection, owner): the aggregation needs nothing finer, and a
  // large wallet would otherwise freeze thousands of token ids per point.
  const countByHolding = new Map<string, { chainId: number; collection: string; owner: string; count: number }>();
  for (const item of input.nftItems) {
    const key = `${item.chainId}:${item.collection}:${item.owner}`;
    const existing = countByHolding.get(key);
    const count = Number(item.amount || '1');

    if (existing) {
      existing.count += count;
    } else {
      countByHolding.set(key, { chainId: item.chainId, collection: item.collection, owner: item.owner, count });
    }
  }

  return {
    balances: input.balances.map((balance) => ({
      chainId: balance.chainId,
      owner: balance.owner,
      token: balance.token,
      amount: balance.amount,
    })),
    tokens: tokens.map((token) => ({
      id: token.id,
      chainId: token.chainId,
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      coingeckoId: token.coingeckoId,
      isSpam: token.isSpam,
      spamReason: token.spamReason,
    })),
    prices: input.prices
      .filter((price) => relevantPriceKeys.has(price.id))
      .map((price) => ({ id: price.id, priceUsd: price.priceUsd })),
    nftCollections: input.nftCollections
      .filter((collection) => heldCollectionIds.has(collection.id))
      .map((collection) => ({
        id: collection.id,
        chainId: collection.chainId,
        address: collection.address,
        name: collection.name ?? collection.symbol,
        floorPriceUsd: collection.floorPriceUsd ?? null,
      })),
    nftHoldings: [...countByHolding.values()],
    exchangeBalances: input.exchangeBalances.map((balance) => ({
      accountId: balance.accountId,
      asset: balance.asset,
      amount: balance.amount,
    })),
    exchangeAccounts: input.exchangeAccounts.map((account) => ({
      id: account.id,
      label: account.label,
      exchange: account.exchange,
    })),
    exchangeAssetCoingeckoIds: input.exchangeAssetCoingeckoIds,
    manualHoldings: (input.manualHoldings ?? []).map((holding) => ({
      balanceId: holding.balance.id,
      symbol: holding.balance.symbol,
      coingeckoId: holding.balance.coingeckoId,
      location: holding.balance.location,
      wallet: holding.balance.wallet,
      amount: holding.amount,
    })),
    fiatRatesPerUsd: input.fiatRatesPerUsd,
  };
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
