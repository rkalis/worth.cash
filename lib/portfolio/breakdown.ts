import { chainIdSorter } from 'lib/chains';
import type { ExchangeKind } from 'lib/db/schema';
import type { AggregatedNftCollection, AggregatedToken } from 'lib/portfolio/aggregate';

export interface BreakdownEntry {
  key: string;
  label: string;
  valueUsd: number;
  // Set for chain-backed entries, so the UI can show a chain logo. Absent for exchanges and the remainder.
  chainId?: number;
  // Set for exchange-backed entries, for the same reason.
  exchange?: ExchangeKind;
  // True for the single row standing in for everything not listed individually.
  isRemainder?: boolean;
}

export interface BreakdownOptions {
  // Entries worth less than this are folded into the remainder rather than listed. A portfolio spread over
  // ninety chains accumulates a long tail of sub-dollar dust that says nothing about where the money is.
  minimumUsd?: number;
  maximumEntries?: number;
}

export const DEFAULT_BREAKDOWN_MINIMUM_USD = 10;
export const DEFAULT_BREAKDOWN_LIMIT = 10;

// Groups a set of valued positions into a ranked breakdown.
//
// Anything cut by the threshold or the limit is summed into a single remainder row rather than dropped. A
// column of figures under a headline total invites adding it up, and a breakdown that quietly omits part of
// the total reads as an arithmetic error.
const buildBreakdown = (
  entries: Array<{ key: string; label: string; valueUsd: number; chainId?: number; exchange?: ExchangeKind }>,
  options: BreakdownOptions = {},
): BreakdownEntry[] => {
  const minimumUsd = options.minimumUsd ?? DEFAULT_BREAKDOWN_MINIMUM_USD;
  const maximumEntries = options.maximumEntries ?? DEFAULT_BREAKDOWN_LIMIT;

  const sorted = [...entries].sort((a, b) => {
    const byValue = b.valueUsd - a.valueUsd;
    if (byValue !== 0) return byValue;

    // Ties fall back to the app's chain order, so equal-valued rows keep a stable position.
    if (a.chainId !== undefined && b.chainId !== undefined) return chainIdSorter(a.chainId, b.chainId);
    return a.label.localeCompare(b.label);
  });

  const listed = sorted.filter((entry) => entry.valueUsd >= minimumUsd).slice(0, maximumEntries);
  const listedKeys = new Set(listed.map((entry) => entry.key));

  const remainder = sorted
    .filter((entry) => !listedKeys.has(entry.key))
    .reduce((total, entry) => total + entry.valueUsd, 0);

  const remainderCount = sorted.length - listed.length;

  // Sub-cent remainders would render as "$0.00", which looks like a bug rather than a rounding artefact.
  if (remainder < 0.01 || remainderCount === 0) return listed;

  return [
    ...listed,
    {
      key: 'remainder',
      label: `Other (${remainderCount} ${remainderCount === 1 ? 'entry' : 'entries'})`,
      valueUsd: remainder,
      isRemainder: true,
    },
  ];
};

// Token value per chain. Built from each row's chain locations rather than from its total, since one asset
// contributes to every place it is held, and an exchange holding is not on a chain at all.
export const buildTokenChainBreakdown = (tokens: AggregatedToken[], options?: BreakdownOptions): BreakdownEntry[] => {
  const valueByChain = new Map<number, { chainName: string; valueUsd: number }>();

  for (const token of tokens) {
    for (const location of token.locations) {
      if (location.kind !== 'chain' || !location.valueUsd) continue;

      const existing = valueByChain.get(location.chainId);
      if (existing) {
        existing.valueUsd += location.valueUsd;
      } else {
        valueByChain.set(location.chainId, { chainName: location.name, valueUsd: location.valueUsd });
      }
    }
  }

  return buildBreakdown(
    [...valueByChain.entries()].map(([chainId, entry]) => ({
      key: String(chainId),
      label: entry.chainName,
      valueUsd: entry.valueUsd,
      chainId,
    })),
    options,
  );
};

export const buildNftChainBreakdown = (
  collections: AggregatedNftCollection[],
  options?: BreakdownOptions,
): BreakdownEntry[] => {
  const valueByChain = new Map<number, { chainName: string; valueUsd: number }>();

  for (const collection of collections) {
    if (!collection.valueUsd) continue;

    const existing = valueByChain.get(collection.chainId);
    if (existing) {
      existing.valueUsd += collection.valueUsd;
    } else {
      valueByChain.set(collection.chainId, { chainName: collection.chainName, valueUsd: collection.valueUsd });
    }
  }

  return buildBreakdown(
    [...valueByChain.entries()].map(([chainId, entry]) => ({
      key: String(chainId),
      label: entry.chainName,
      valueUsd: entry.valueUsd,
      chainId,
    })),
    options,
  );
};

// Exchange value per account rather than per asset, since the question this answers is "how much is sitting
// on Kraken", not "how much SOL do I hold".
export const buildExchangeBreakdown = (tokens: AggregatedToken[], options?: BreakdownOptions): BreakdownEntry[] => {
  const valueByAccount = new Map<string, { label: string; exchange: ExchangeKind; valueUsd: number }>();

  for (const token of tokens) {
    for (const location of token.locations) {
      if (location.kind !== 'exchange' || !location.valueUsd) continue;

      const existing = valueByAccount.get(location.accountId);
      if (existing) {
        existing.valueUsd += location.valueUsd;
      } else {
        valueByAccount.set(location.accountId, {
          label: location.name,
          exchange: location.exchange,
          valueUsd: location.valueUsd,
        });
      }
    }
  }

  return buildBreakdown(
    [...valueByAccount.entries()].map(([accountId, entry]) => ({
      key: accountId,
      label: entry.label,
      valueUsd: entry.valueUsd,
      exchange: entry.exchange,
    })),
    // Nobody has ten exchange accounts, so the limit only ever gets in the way here.
    { maximumEntries: Number.POSITIVE_INFINITY, ...options },
  );
};
