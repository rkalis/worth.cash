import { chainIdSorter } from 'lib/chains';
import type { ExchangeKind, StoredAssetCategory } from 'lib/db/schema';
import type { AggregatedNftCollection, AggregatedToken } from 'lib/portfolio/aggregate';

export interface BreakdownEntry {
  key: string;
  label: string;
  valueUsd: number;
  // Set for chain-backed entries, so the UI can show a chain logo. Absent for exchanges and the remainder.
  chainId?: number;
  // Set for exchange-backed entries, for the same reason.
  exchange?: ExchangeKind;
  // True for a hand-entered holding, which has neither a chain nor a brand to show.
  isManual?: boolean;
  // True for the single row standing in for everything not listed individually.
  isRemainder?: boolean;
  // A colour the entry keeps whatever its rank. Only categories set this: a category's colour comes from
  // the user's own ordering, so that "stablecoins" stays the same colour when it grows or shrinks.
  color?: string;
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
  entries: Array<{
    key: string;
    label: string;
    valueUsd: number;
    chainId?: number;
    exchange?: ExchangeKind;
    isManual?: boolean;
  }>,
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

// Manual holdings grouped by the location the user gave them, so several assets in one place read as one
// line rather than one per asset.
export const buildManualBreakdown = (tokens: AggregatedToken[], options?: BreakdownOptions): BreakdownEntry[] => {
  const valueByLocation = new Map<string, number>();

  for (const token of tokens) {
    for (const location of token.locations) {
      if (location.kind !== 'manual' || !location.valueUsd) continue;

      valueByLocation.set(location.name, (valueByLocation.get(location.name) ?? 0) + location.valueUsd);
    }
  }

  return buildBreakdown(
    [...valueByLocation.entries()].map(([label, valueUsd]) => ({
      key: `manual:${label}`,
      label,
      valueUsd,
      isManual: true,
    })),
    // Bounded by however many places the user chose to name, which is never many.
    { maximumEntries: Number.POSITIVE_INFINITY, ...options },
  );
};

// Every place the money sits, in one ranked list.
//
// The summary tiles keep chains, exchanges and hand-entered holdings apart, because each tile answers a
// question about its own kind. A single breakdown answers a different question -- where is the portfolio,
// counting everything -- so an exchange account stands beside a chain rather than under its own heading, and
// a chain's tokens and its NFTs are one line rather than two, since they are one place.
export const buildLocationBreakdown = (
  tokens: AggregatedToken[],
  nftCollections: AggregatedNftCollection[],
  options?: BreakdownOptions,
): BreakdownEntry[] => {
  const entries = new Map<
    string,
    { label: string; valueUsd: number; chainId?: number; exchange?: ExchangeKind; isManual?: boolean }
  >();

  const add = (
    key: string,
    label: string,
    valueUsd: number,
    extra: { chainId?: number; exchange?: ExchangeKind; isManual?: boolean } = {},
  ) => {
    if (!valueUsd) return;

    const existing = entries.get(key);
    if (existing) {
      existing.valueUsd += valueUsd;
    } else {
      entries.set(key, { label, valueUsd, ...extra });
    }
  };

  for (const token of tokens) {
    for (const location of token.locations) {
      if (!location.valueUsd) continue;

      if (location.kind === 'chain') {
        add(`chain:${location.chainId}`, location.name, location.valueUsd, { chainId: location.chainId });
      } else if (location.kind === 'exchange') {
        add(`exchange:${location.accountId}`, location.name, location.valueUsd, { exchange: location.exchange });
      } else {
        add(`manual:${location.name.toLowerCase()}`, location.name, location.valueUsd, { isManual: true });
      }
    }
  }

  // NFTs join the chain they are on. A collection is held in the same place as the tokens beside it, and
  // splitting them would answer "where is my money" with two lines for one wallet on one chain.
  for (const collection of nftCollections) {
    add(`chain:${collection.chainId}`, collection.chainName, collection.valueUsd ?? 0, {
      chainId: collection.chainId,
    });
  }

  return buildBreakdown(
    [...entries.entries()].map(([key, entry]) => ({ key, ...entry })),
    options,
  );
};

// Every asset, whatever it is and wherever it is held.
//
// The mirror of the location breakdown: the same total, cut the other way. A token row already spans every
// chain and exchange it is held on, which is exactly the granularity this wants, and an NFT collection is
// one asset in the same sense.
export const buildAssetBreakdown = (
  tokens: AggregatedToken[],
  nftCollections: AggregatedNftCollection[],
  options?: BreakdownOptions,
): BreakdownEntry[] =>
  buildBreakdown(
    [
      ...tokens.map((token) => ({ key: token.key, label: token.symbol, valueUsd: token.valueUsd ?? 0 })),
      ...nftCollections.map((collection) => ({
        key: collection.key,
        label: collection.name,
        valueUsd: collection.valueUsd ?? 0,
        chainId: collection.chainId,
      })),
    ].filter((entry) => entry.valueUsd > 0),
    options,
  );

// Colours handed to categories, in the user's ordering.
export const CATEGORY_COLORS = [
  '#fdb952',
  '#3b82f6',
  '#10b981',
  '#a855f7',
  '#ef4444',
  '#06b6d4',
  '#f97316',
  '#84cc16',
  '#ec4899',
  '#6366f1',
];

// Everything nobody filed, kept apart by what kind of thing it is. Deliberately neutral: these are not
// categories the user chose, they are what is left.
const UNCATEGORISED_TOKEN_COLOR = '#a1a1aa';
const UNCATEGORISED_NFT_COLOR = '#64748b';

export const UNCATEGORISED_TOKENS_KEY = 'uncategorised:tokens';
export const UNCATEGORISED_NFTS_KEY = 'uncategorised:nfts';

// The portfolio through the user's own lens.
//
// Unlike the other breakdowns, this one is not derived from the data alone: the groupings are invented by
// the user and an asset belongs to one only because they said so. Everything they have not filed falls into
// one of two buckets rather than into a single "other", because "what is not blue chip" is a different
// question for tokens than it is for NFTs, and merging them answers neither.
//
// An empty category is left out. A user who makes a category and files nothing under it has said nothing
// about their portfolio, and a zero-width slice is not worth a line in the legend.
export const buildCategoryBreakdown = (
  tokens: AggregatedToken[],
  nftCollections: AggregatedNftCollection[],
  categories: StoredAssetCategory[],
): BreakdownEntry[] => {
  const ordered = [...categories].sort((a, b) => a.sortIndex - b.sortIndex);
  const colorByCategoryId = new Map(
    ordered.map((category, index) => [category.id, CATEGORY_COLORS[index % CATEGORY_COLORS.length]]),
  );
  const knownCategoryIds = new Set(ordered.map((category) => category.id));

  const valueByKey = new Map<string, number>();
  const add = (key: string, valueUsd: number) => {
    if (!valueUsd) return;
    valueByKey.set(key, (valueByKey.get(key) ?? 0) + valueUsd);
  };

  // An assignment to a category that has since been deleted reads as unfiled rather than as a category of
  // its own, so a deleted category cannot leave a nameless slice behind.
  for (const token of tokens) {
    const key =
      token.categoryId && knownCategoryIds.has(token.categoryId) ? token.categoryId : UNCATEGORISED_TOKENS_KEY;
    add(key, token.valueUsd ?? 0);
  }

  for (const collection of nftCollections) {
    const key =
      collection.categoryId && knownCategoryIds.has(collection.categoryId)
        ? collection.categoryId
        : UNCATEGORISED_NFTS_KEY;
    add(key, collection.valueUsd ?? 0);
  }

  const entries = [
    ...ordered.map((category) => ({
      key: category.id,
      label: category.name,
      valueUsd: valueByKey.get(category.id) ?? 0,
      color: colorByCategoryId.get(category.id),
    })),
    {
      key: UNCATEGORISED_TOKENS_KEY,
      label: 'Other tokens',
      valueUsd: valueByKey.get(UNCATEGORISED_TOKENS_KEY) ?? 0,
      color: UNCATEGORISED_TOKEN_COLOR,
    },
    {
      key: UNCATEGORISED_NFTS_KEY,
      label: 'Other NFTs',
      valueUsd: valueByKey.get(UNCATEGORISED_NFTS_KEY) ?? 0,
      color: UNCATEGORISED_NFT_COLOR,
    },
  ];

  // Ranked by value like every other breakdown, but nothing is ever folded away: a category the user made
  // is worth a line however small it is, which is the whole reason they made it.
  return entries
    .filter((entry) => entry.valueUsd >= 0.01)
    .sort((a, b) => b.valueUsd - a.valueUsd || a.label.localeCompare(b.label));
};
