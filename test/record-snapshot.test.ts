import type { AggregationInput } from 'lib/portfolio/aggregate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const put = vi.fn();
let aggregationInput: AggregationInput;
let wallets: Array<{ address: string; enabled: number; addedAt: number }> = [];

vi.mock('lib/db', () => ({
  db: { snapshots: { put: (row: unknown) => put(row) }, settings: { get: async () => undefined } },
}));

// The real aggregation and fact-cutting run; only the reading of the tables is stubbed. That is the
// property worth testing: a recorded point stores the same input the dashboard aggregated, not a summary.
vi.mock('lib/portfolio/load', () => ({
  loadPortfolioSource: async () => ({ wallets }),
  buildAggregationInput: () => aggregationInput,
}));

const { recordCurrentSnapshot } = await import('lib/history/snapshot');

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const OWNER = '0x1111111111111111111111111111111111111111';
const OWNER_B = '0x2222222222222222222222222222222222222222';

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
  spamSettings: {
    dustThresholdUsd: 1,
    dustThresholdAmount: 0.000001,
    hideUnpricedTokens: true,
    useSpamHeuristics: true,
  },
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
        updatedAt: 0,
      },
      {
        id: `1:${OWNER_B}:${NATIVE}`,
        chainId: 1,
        owner: OWNER_B,
        token: NATIVE,
        standard: 'erc20',
        amount: '2000000000000000000',
        updatedAt: 0,
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
        metadataUpdatedAt: 0,
      },
    ],
    prices: [{ id: 'coingecko:ethereum', priceUsd: 2000, updatedAt: 0 }],
    exchangeBalances: [{ id: 'acct:ETH', accountId: 'acct', asset: 'ETH', amount: '3', updatedAt: 0 }],
    exchangeAccounts: [{ id: 'acct', label: 'Kraken', exchange: 'kraken' }],
    exchangeAssetCoingeckoIds: { ETH: 'ethereum' },
  });

beforeEach(() => {
  put.mockReset();
  wallets = [
    { address: OWNER, enabled: 1, addedAt: 0 },
    { address: OWNER_B, enabled: 1, addedAt: 0 },
  ];
});

describe('recordCurrentSnapshot', () => {
  it('records the same total the dashboard is showing', async () => {
    aggregationInput = withEthOnChainAndOnKraken();
    await recordCurrentSnapshot(1_000);

    const [snapshot] = put.mock.calls[0];
    // 6 ETH on-chain + 3 ETH on Kraken, at $2,000.
    expect(snapshot.totalUsd).toBe(18_000);
    expect(snapshot.timestamp).toBe(1_000);
  });

  it('stores the balance rows with their owners, so a wallet can be taken back out', async () => {
    aggregationInput = withEthOnChainAndOnKraken();
    await recordCurrentSnapshot(1_000);

    const [snapshot] = put.mock.calls[0];
    expect(snapshot.balances).toEqual([
      { chainId: 1, owner: OWNER, token: NATIVE, amount: '4000000000000000000' },
      { chainId: 1, owner: OWNER_B, token: NATIVE, amount: '2000000000000000000' },
    ]);
  });

  it('keeps the exchange holding on its account', async () => {
    aggregationInput = withEthOnChainAndOnKraken();
    await recordCurrentSnapshot(1_000);

    const [snapshot] = put.mock.calls[0];
    expect(snapshot.exchangeBalances).toEqual([{ accountId: 'acct', asset: 'ETH', amount: '3' }]);
    expect(snapshot.exchangeAccounts).toEqual([{ id: 'acct', label: 'Kraken', exchange: 'kraken' }]);
  });

  it('stamps the scope and the attributed wallets, including ones that held nothing', async () => {
    aggregationInput = withEthOnChainAndOnKraken();
    wallets.push({ address: '0x3333333333333333333333333333333333333333', enabled: 1, addedAt: 0 });
    await recordCurrentSnapshot(1_000);

    const [snapshot] = put.mock.calls[0];
    expect(snapshot.attributedOwners).toEqual([OWNER, OWNER_B, '0x3333333333333333333333333333333333333333']);
    expect(snapshot.scope?.wallets).toEqual(snapshot.attributedOwners);
  });

  it('refuses to record an empty portfolio rather than writing a false zero', async () => {
    aggregationInput = buildInput();
    const result = await recordCurrentSnapshot(1_000);

    expect(result).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });
});
