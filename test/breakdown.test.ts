import type {
  AggregatedNftCollection,
  AggregatedToken,
  TokenChainLocation,
  TokenExchangeLocation,
} from 'lib/portfolio/aggregate';
import { buildExchangeBreakdown, buildNftChainBreakdown, buildTokenChainBreakdown } from 'lib/portfolio/breakdown';
import type { ChainSyncTask } from 'lib/sync/progress';
import { compareTasks } from 'lib/sync/progress';
import { describe, expect, it } from 'vitest';

// Built without a cast, deliberately: a cast would let the aggregate's shape drift out from under these
// tests and they would keep passing against a type that no longer exists.
const buildChainLocation = (chainId: number, chainName: string, valueUsd: number | null): TokenChainLocation => ({
  kind: 'chain',
  key: `chain:${chainId}`,
  chainId,
  name: chainName,
  amount: 1,
  valueUsd,
  contracts: [{ token: '0x0000000000000000000000000000000000000001', amount: 1 }],
});

const buildExchangeLocation = (
  accountId: string,
  label: string,
  valueUsd: number | null,
  exchange: TokenExchangeLocation['exchange'] = 'kraken',
): TokenExchangeLocation => ({
  kind: 'exchange',
  key: `exchange:${accountId}`,
  accountId,
  exchange,
  asset: 'BTC',
  name: label,
  amount: 1,
  valueUsd,
});

const buildToken = (locations: Array<TokenChainLocation | TokenExchangeLocation>): AggregatedToken => {
  const sumFor = (kind: 'chain' | 'exchange' | 'manual') =>
    locations
      .filter((location) => location.kind === kind)
      .reduce((total, location) => total + (location.valueUsd ?? 0), 0);

  return {
    key: locations.map((location) => location.key).join('+'),
    symbol: 'TEST',
    overrideKey: 'coin:test',
    supersededOverrideKeys: [],
    totalAmount: locations.length,
    priceUsd: 1,
    valueUsd: sumFor('chain') + sumFor('exchange'),
    locations,
    chainValueUsd: sumFor('chain'),
    exchangeValueUsd: sumFor('exchange'),
    manualValueUsd: sumFor('manual'),
    isSpam: false,
    isHidden: false,
  };
};

const buildCollection = (chainId: number, chainName: string, valueUsd: number | null): AggregatedNftCollection => ({
  key: `${chainId}:${valueUsd}`,
  chainId,
  chainName,
  address: '0x0000000000000000000000000000000000000002',
  name: 'Collection',
  itemCount: 1,
  floorPriceUsd: valueUsd,
  valueUsd,
  items: [],
  isHidden: false,
});

describe('buildTokenChainBreakdown', () => {
  it('sums a cross-chain position into each chain it is held on', () => {
    const breakdown = buildTokenChainBreakdown([
      buildToken([buildChainLocation(1, 'Ethereum', 500), buildChainLocation(8453, 'Base', 300)]),
      buildToken([buildChainLocation(8453, 'Base', 200)]),
    ]);

    // Equal values fall back to the app's chain order, which puts Ethereum ahead of Base.
    expect(breakdown.map((entry) => [entry.label, entry.valueUsd])).toEqual([
      ['Ethereum', 500],
      ['Base', 500],
    ]);
  });

  it('ranks by value, descending', () => {
    const breakdown = buildTokenChainBreakdown([
      buildToken([buildChainLocation(1, 'Ethereum', 100)]),
      buildToken([buildChainLocation(10, 'Optimism', 900)]),
      buildToken([buildChainLocation(8453, 'Base', 400)]),
    ]);

    expect(breakdown.map((entry) => entry.label)).toEqual(['Optimism', 'Base', 'Ethereum']);
  });

  it('folds chains below the minimum into a remainder row instead of dropping them', () => {
    const breakdown = buildTokenChainBreakdown([
      buildToken([buildChainLocation(1, 'Ethereum', 100)]),
      buildToken([buildChainLocation(10, 'Optimism', 4)]),
      buildToken([buildChainLocation(8453, 'Base', 3)]),
    ]);

    expect(breakdown).toHaveLength(2);
    expect(breakdown[0]).toMatchObject({ label: 'Ethereum', valueUsd: 100 });
    expect(breakdown[1]).toMatchObject({ label: 'Other (2 entries)', valueUsd: 7, isRemainder: true });
    expect(breakdown[1].chainId).toBeUndefined();
  });

  // The listed rows sit under a headline total, so they have to add up to it.
  it('reconciles listed entries plus the remainder with the overall total', () => {
    const tokens = Array.from({ length: 15 }, (_, index) =>
      buildToken([buildChainLocation(index + 1, `Chain ${index + 1}`, (index + 1) * 20)]),
    );

    const breakdown = buildTokenChainBreakdown(tokens);
    const total = tokens.reduce((sum, token) => sum + (token.valueUsd ?? 0), 0);

    expect(breakdown).toHaveLength(11);
    expect(breakdown.reduce((sum, entry) => sum + entry.valueUsd, 0)).toBeCloseTo(total);
  });

  it('lists at most ten chains', () => {
    const breakdown = buildTokenChainBreakdown(
      Array.from({ length: 12 }, (_, index) =>
        buildToken([buildChainLocation(index + 1, `Chain ${index + 1}`, 1000 - index)]),
      ),
    );

    expect(breakdown.filter((entry) => !entry.isRemainder)).toHaveLength(10);
  });

  it('ignores chains with no value at all', () => {
    const breakdown = buildTokenChainBreakdown([
      buildToken([buildChainLocation(1, 'Ethereum', 100), buildChainLocation(10, 'Optimism', null)]),
    ]);

    expect(breakdown.map((entry) => entry.label)).toEqual(['Ethereum']);
  });

  it('returns nothing when there is nothing to show', () => {
    expect(buildTokenChainBreakdown([])).toEqual([]);
  });
});

describe('buildNftChainBreakdown', () => {
  it('groups collections by chain', () => {
    const breakdown = buildNftChainBreakdown([
      buildCollection(1, 'Ethereum', 400),
      buildCollection(1, 'Ethereum', 150),
      buildCollection(8453, 'Base', 90),
      buildCollection(10, 'Optimism', 5),
    ]);

    expect(breakdown.map((entry) => [entry.label, entry.valueUsd])).toEqual([
      ['Ethereum', 550],
      ['Base', 90],
      ['Other (1 entry)', 5],
    ]);
  });

  it('carries the chain id so the row can render a logo', () => {
    const [entry] = buildNftChainBreakdown([buildCollection(8453, 'Base', 90)]);
    expect(entry.chainId).toBe(8453);
  });
});

describe('buildExchangeBreakdown', () => {
  it('groups exchange locations by account rather than by asset', () => {
    const breakdown = buildExchangeBreakdown([
      buildToken([
        buildExchangeLocation('kraken-1', 'Kraken', 2000),
        buildExchangeLocation('coinbase-1', 'Coinbase', 900, 'coinbase'),
      ]),
      buildToken([buildExchangeLocation('kraken-1', 'Kraken', 300)]),
    ]);

    expect(breakdown.map((entry) => [entry.label, entry.valueUsd])).toEqual([
      ['Kraken', 2300],
      ['Coinbase', 900],
    ]);
  });

  it('carries the exchange so the row can render a brand mark', () => {
    const [entry] = buildExchangeBreakdown([
      buildToken([buildExchangeLocation('coinbase-1', 'Coinbase', 900, 'coinbase')]),
    ]);
    expect(entry.exchange).toBe('coinbase');
    expect(entry.chainId).toBeUndefined();
  });

  // The two breakdowns split one merged row between them, and neither may claim the other's money.
  it('ignores chain locations, as the chain breakdown ignores exchange ones', () => {
    const tokens = [
      buildToken([buildChainLocation(1, 'Ethereum', 5000), buildExchangeLocation('kraken-1', 'Kraken', 2000)]),
    ];

    expect(buildExchangeBreakdown(tokens).map((entry) => [entry.label, entry.valueUsd])).toEqual([['Kraken', 2000]]);
    expect(buildTokenChainBreakdown(tokens).map((entry) => [entry.label, entry.valueUsd])).toEqual([
      ['Ethereum', 5000],
    ]);
  });

  it('applies the same minimum as the chain breakdowns', () => {
    const breakdown = buildExchangeBreakdown([
      buildToken([
        buildExchangeLocation('kraken-1', 'Kraken', 2000),
        buildExchangeLocation('coinbase-1', 'Coinbase', 4, 'coinbase'),
      ]),
    ]);

    expect(breakdown.map((entry) => entry.label)).toEqual(['Kraken', 'Other (1 entry)']);
  });

  // Chains are capped at ten because there are ninety of them. Accounts are not, because there are never
  // enough of them for a cap to do anything but hide one.
  it('does not cap the number of accounts', () => {
    const breakdown = buildExchangeBreakdown([
      buildToken(
        Array.from({ length: 12 }, (_, index) =>
          buildExchangeLocation(`account-${index}`, `Account ${index}`, 1000 - index),
        ),
      ),
    ]);

    expect(breakdown).toHaveLength(12);
    expect(breakdown.some((entry) => entry.isRemainder)).toBe(false);
  });
});

describe('compareTasks', () => {
  const buildTask = (chainId: number, status: ChainSyncTask['status']): ChainSyncTask => ({
    chainId,
    owner: '0x1111111111111111111111111111111111111111',
    status,
    phase: 'done',
  });

  it('orders failed, then syncing, then pending, then done, then skipped', () => {
    const tasks = [
      buildTask(1, 'skipped'),
      buildTask(1, 'done'),
      buildTask(1, 'pending'),
      buildTask(1, 'syncing'),
      buildTask(1, 'error'),
    ];

    expect([...tasks].sort(compareTasks).map((task) => task.status)).toEqual([
      'error',
      'syncing',
      'pending',
      'done',
      'skipped',
    ]);
  });

  // Rows shuffling as the sync progresses makes the list unreadable, so equal statuses keep a fixed order.
  it('falls back to the app chain order within a status', () => {
    const tasks = [buildTask(8453, 'done'), buildTask(1, 'done'), buildTask(10, 'done')];
    const sorted = [...tasks].sort(compareTasks);

    expect(sorted[0].chainId).toBe(1);
    expect(sorted.map((task) => task.chainId)).toHaveLength(3);
  });
});
