import type { StoredAssetCategory, StoredCategoryAssignment } from 'lib/db/schema';
import type { AggregatedNftCollection, AggregatedToken, TokenChainLocation } from 'lib/portfolio/aggregate';
import { aggregateTokens } from 'lib/portfolio/aggregate';
import {
  buildCategoryBreakdown,
  CATEGORY_COLORS,
  UNCATEGORISED_NFTS_KEY,
  UNCATEGORISED_TOKENS_KEY,
} from 'lib/portfolio/breakdown';
import { describe, expect, it } from 'vitest';

const buildCategory = (id: string, name: string, sortIndex: number): StoredAssetCategory => ({
  id,
  name,
  sortIndex,
  createdAt: 0,
});

const buildChainLocation = (valueUsd: number): TokenChainLocation => ({
  kind: 'chain',
  key: 'chain:1',
  chainId: 1,
  name: 'Ethereum',
  amount: 1,
  valueUsd,
  contracts: [{ token: '0x0000000000000000000000000000000000000001', amount: 1 }],
});

const buildToken = (key: string, valueUsd: number, categoryId?: string): AggregatedToken => ({
  key,
  symbol: key.toUpperCase(),
  overrideKey: key,
  supersededOverrideKeys: [],
  categoryId,
  totalAmount: 1,
  priceUsd: valueUsd,
  valueUsd,
  locations: [buildChainLocation(valueUsd)],
  chainValueUsd: valueUsd,
  exchangeValueUsd: 0,
  manualValueUsd: 0,
  isSpam: false,
  isHidden: false,
});

const buildCollection = (key: string, valueUsd: number, categoryId?: string): AggregatedNftCollection => ({
  key,
  chainId: 1,
  chainName: 'Ethereum',
  address: '0x0000000000000000000000000000000000000002',
  name: key,
  itemCount: 1,
  categoryId,
  floorPriceUsd: valueUsd,
  valueUsd,
  items: [],
  isHidden: false,
});

describe('buildCategoryBreakdown', () => {
  const blueChip = buildCategory('c1', 'Blue Chip', 0);
  const stablecoins = buildCategory('c2', 'Stablecoins', 1);

  it('splits the portfolio between the categories the user made', () => {
    const breakdown = buildCategoryBreakdown(
      [buildToken('eth', 6000, 'c1'), buildToken('usdc', 4000, 'c2')],
      [],
      [blueChip, stablecoins],
    );

    expect(breakdown.map((entry) => [entry.label, entry.valueUsd])).toEqual([
      ['Blue Chip', 6000],
      ['Stablecoins', 4000],
    ]);
  });

  // What the user asked for: everything unfiled lands in one of two buckets, split by what it is, so
  // nothing has to be categorised for the chart to add up.
  it('files anything uncategorised under Other tokens or Other NFTs', () => {
    const breakdown = buildCategoryBreakdown(
      [buildToken('eth', 6000, 'c1'), buildToken('pepe', 300)],
      [buildCollection('apes', 900)],
      [blueChip],
    );

    expect(breakdown.map((entry) => [entry.key, entry.label, entry.valueUsd])).toEqual([
      ['c1', 'Blue Chip', 6000],
      [UNCATEGORISED_NFTS_KEY, 'Other NFTs', 900],
      [UNCATEGORISED_TOKENS_KEY, 'Other tokens', 300],
    ]);
  });

  it('keeps a categorised NFT collection out of the leftovers', () => {
    const breakdown = buildCategoryBreakdown([], [buildCollection('apes', 900, 'c1')], [blueChip]);

    expect(breakdown.map((entry) => entry.label)).toEqual(['Blue Chip']);
  });

  // A category is a claim about the portfolio; an empty one is not.
  it('leaves out a category nothing is filed under', () => {
    const breakdown = buildCategoryBreakdown([buildToken('eth', 6000, 'c1')], [], [blueChip, stablecoins]);

    expect(breakdown.map((entry) => entry.label)).toEqual(['Blue Chip']);
  });

  // Deleting a category takes its assignments with it, but a stale assignment must not survive as a slice
  // with no name.
  it('treats an assignment to a category that no longer exists as unfiled', () => {
    const breakdown = buildCategoryBreakdown([buildToken('eth', 6000, 'deleted-category')], [], [blueChip]);

    expect(breakdown.map((entry) => [entry.key, entry.valueUsd])).toEqual([[UNCATEGORISED_TOKENS_KEY, 6000]]);
  });

  // The colour is taken from the user's ordering, not from the ranking, so a category does not change
  // colour when it overtakes another one.
  it('gives a category the same colour whatever it is worth', () => {
    const small = buildCategoryBreakdown(
      [buildToken('eth', 10, 'c1'), buildToken('usdc', 9000, 'c2')],
      [],
      [blueChip, stablecoins],
    );
    const large = buildCategoryBreakdown(
      [buildToken('eth', 9000, 'c1'), buildToken('usdc', 10, 'c2')],
      [],
      [blueChip, stablecoins],
    );

    const colorOf = (breakdown: ReturnType<typeof buildCategoryBreakdown>, label: string) =>
      breakdown.find((entry) => entry.label === label)?.color;

    expect(colorOf(small, 'Blue Chip')).toBe(CATEGORY_COLORS[0]);
    expect(colorOf(large, 'Blue Chip')).toBe(CATEGORY_COLORS[0]);
    expect(colorOf(small, 'Stablecoins')).toBe(CATEGORY_COLORS[1]);
  });

  it('adds up to the same total whatever is filed where', () => {
    const tokens = [buildToken('eth', 6000, 'c1'), buildToken('usdc', 4000, 'c2'), buildToken('pepe', 300)];
    const collections = [buildCollection('apes', 900, 'c1'), buildCollection('punks', 500)];

    const total = buildCategoryBreakdown(tokens, collections, [blueChip, stablecoins]).reduce(
      (sum, entry) => sum + entry.valueUsd,
      0,
    );

    expect(total).toBe(11700);
  });
});

describe('resolving an asset to its category during aggregation', () => {
  const buildInput = (assignments: StoredCategoryAssignment[]) => ({
    balances: [
      {
        id: '1:0xowner:0xtoken',
        chainId: 1,
        owner: '0x1111111111111111111111111111111111111111',
        token: '0x00000000000000000000000000000000000000aa',
        standard: 'erc20' as const,
        amount: '1000000000000000000',
        updatedAt: 0,
      },
    ],
    tokens: [
      {
        id: '1:0x00000000000000000000000000000000000000aa',
        chainId: 1,
        address: '0x00000000000000000000000000000000000000aa',
        standard: 'erc20' as const,
        symbol: 'TKN',
        decimals: 18,
        coingeckoId: 'some-coin',
        isSpam: 0 as const,
        metadataUpdatedAt: 0,
      },
    ],
    prices: [{ id: 'coingecko:some-coin', priceUsd: 1000, updatedAt: 0 }],
    overrides: [],
    nftCollections: [],
    nftItems: [],
    exchangeBalances: [],
    exchangeAccounts: [],
    exchangeAssetCoingeckoIds: {},
    categoryAssignments: assignments,
    spamSettings: {
      dustThresholdUsd: 0,
      dustThresholdAmount: 0.000001,
      hideUnpricedTokens: false,
      useSpamHeuristics: false,
    },
  });

  it('finds the category filed under the asset identity', () => {
    const [token] = aggregateTokens(buildInput([{ id: 'coin:some-coin', categoryId: 'c1', updatedAt: 0 }]));

    expect(token.categoryId).toBe('c1');
  });

  // The reason assignments are written against every key an asset could be found under: a coin id can
  // disappear when a metadata refresh fails, dropping the asset back to a per-contract key. Filing it must
  // survive that, exactly as a hide decision does.
  it('finds it under a key the asset used to be known by', () => {
    const [token] = aggregateTokens(
      buildInput([{ id: '1:0x00000000000000000000000000000000000000aa', categoryId: 'c2', updatedAt: 0 }]),
    );

    expect(token.categoryId).toBe('c2');
  });

  it('leaves an asset nobody filed uncategorised', () => {
    const [token] = aggregateTokens(buildInput([]));

    expect(token.categoryId).toBeUndefined();
  });
});
