import type { AggregationInput } from 'lib/portfolio/aggregate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const put = vi.fn();
let aggregationInput: AggregationInput;

vi.mock('lib/db', () => ({ db: { snapshots: { put: (row: unknown) => put(row) } } }));

// The real aggregation runs; only the reading of the tables is stubbed. That is the property worth
// testing: a recorded point is the same computation the dashboard shows, not a second implementation.
vi.mock('lib/portfolio/load', () => ({
  loadPortfolioSource: async () => ({}),
  buildAggregationInput: () => aggregationInput,
}));

const { recordCurrentSnapshot } = await import('lib/history/snapshot');
const { aggregateTokens, aggregateNftCollections, calculateTotals } = await import('lib/portfolio/aggregate');

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const OWNER = '0x1111111111111111111111111111111111111111';

const buildInput = (overrides: Partial<AggregationInput> = {}): AggregationInput => ({
  balances: [],
  tokens: [],
  prices: [],
  overrides: [],
  nftCollections: [],
  nftItems: [],
  exchangeBalances: [],
  exchangeAccounts: [],
  exchangeAssetCoingeckoIds: {},
  spamSettings: { dustThresholdUsd: 1, hideUnpricedTokens: true, useSpamHeuristics: true },
  ...overrides,
});

const withEthOnChainAndOnKraken = () =>
  buildInput({
    balances: [
      {
        id: `1:${OWNER}:${NATIVE}`,
        chainId: 1,
        owner: OWNER,
        token: NATIVE,
        standard: 'erc20',
        amount: '4000000000000000000',
        updatedAt: Date.now(),
      },
    ],
    tokens: [
      {
        id: `1:${NATIVE}`,
        chainId: 1,
        address: NATIVE,
        standard: 'erc20',
        symbol: 'ETH',
        decimals: 18,
        coingeckoId: 'ethereum',
        isSpam: 0,
        metadataUpdatedAt: Date.now(),
      },
    ],
    prices: [{ id: 'coingecko:ethereum', priceUsd: 3000, updatedAt: Date.now() }],
    exchangeBalances: [{ id: 'kraken-1:ETH', accountId: 'kraken-1', asset: 'ETH', amount: '2', updatedAt: Date.now() }],
    exchangeAccounts: [{ id: 'kraken-1', label: 'Kraken', exchange: 'kraken' }],
    exchangeAssetCoingeckoIds: { ETH: 'ethereum' },
  });

describe('recordCurrentSnapshot', () => {
  beforeEach(() => {
    put.mockReset();
  });

  it('records the same total the dashboard is showing', async () => {
    aggregationInput = withEthOnChainAndOnKraken();

    const snapshot = await recordCurrentSnapshot(1_000);
    const expected = calculateTotals(aggregateTokens(aggregationInput), aggregateNftCollections(aggregationInput));

    expect(snapshot?.totalUsd).toBe(expected.totalUsd);
    expect(snapshot?.totalUsd).toBe(18000);
    expect(put).toHaveBeenCalledWith(snapshot);
  });

  it('keeps the on-chain and exchange split in its positions', async () => {
    aggregationInput = withEthOnChainAndOnKraken();

    const snapshot = await recordCurrentSnapshot(1_000);

    expect(snapshot?.positions.map((position) => [position.kind, position.valueUsd])).toEqual([
      ['token', 12000],
      ['exchange', 6000],
    ]);
  });

  it('stamps the snapshot with the moment it was asked for', async () => {
    aggregationInput = withEthOnChainAndOnKraken();

    expect((await recordCurrentSnapshot(1_234))?.timestamp).toBe(1_234);
  });

  // A first sync that failed everywhere looks exactly like an empty portfolio, and a zero written then is
  // indistinguishable on the chart from a real one.
  it('writes nothing when there is nothing held', async () => {
    aggregationInput = buildInput();

    expect(await recordCurrentSnapshot()).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  // Hidden positions are excluded from the headline total, so they must be excluded here too.
  it('leaves out positions the user has filtered away', async () => {
    const input = withEthOnChainAndOnKraken();
    aggregationInput = {
      ...input,
      overrides: [{ id: 'coin:ethereum', hidden: 1, updatedAt: Date.now() }],
    };

    expect(await recordCurrentSnapshot()).toBeUndefined();
  });
});
