import type { StoredBalance, StoredToken } from 'lib/db/schema';
import { type AggregationInput, aggregateTokens, calculateTotals } from 'lib/portfolio/aggregate';
import { DEFAULT_SETTINGS } from 'lib/settings/types';
import { describe, expect, it } from 'vitest';

const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x00000000000000000000000000000000000000aa';

const spamSettings = { ...DEFAULT_SETTINGS.spam, dustThresholdUsd: 0, hideUnpricedTokens: false };

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
  spamSettings,
  ...overrides,
});

const withChainBalance = (rawAmount: string, settings = spamSettings): AggregationInput =>
  buildInput({
    balances: [
      {
        id: `1:${OWNER}:${TOKEN}`,
        chainId: 1,
        owner: OWNER,
        token: TOKEN,
        standard: 'erc20',
        amount: rawAmount,
        updatedAt: 0,
      } satisfies StoredBalance,
    ],
    tokens: [
      {
        id: `1:${TOKEN}`,
        chainId: 1,
        address: TOKEN,
        standard: 'erc20',
        symbol: 'TKN',
        decimals: 18,
        coingeckoId: 'some-coin',
        isSpam: 0,
        metadataUpdatedAt: 0,
      } satisfies StoredToken,
    ],
    prices: [{ id: 'coingecko:some-coin', priceUsd: 1000, updatedAt: 0 }],
    spamSettings: settings,
  });

describe('the minimum balance threshold', () => {
  it('defaults to a millionth', () => {
    expect(DEFAULT_SETTINGS.spam.dustThresholdAmount).toBe(0.000001);
  });

  // A single wei of a token worth $1,000 is still worth nothing anyone would act on, and it takes up a row.
  it('ignores a wei-sized remainder', () => {
    expect(aggregateTokens(withChainBalance('1'))).toHaveLength(0);
  });

  it('keeps a holding on the threshold', () => {
    const [position] = aggregateTokens(withChainBalance('1000000000000'));

    expect(position.totalAmount).toBeCloseTo(0.000001);
  });

  it('keeps an ordinary holding', () => {
    const [position] = aggregateTokens(withChainBalance('2000000000000000000'));

    expect(position.totalAmount).toBe(2);
  });

  // Raising it lets someone sweep out a whole class of junk balances at once.
  it('honours a threshold the user raised', () => {
    const raised = { ...spamSettings, dustThresholdAmount: 5 };

    expect(aggregateTokens(withChainBalance('2000000000000000000', raised))).toHaveLength(0);
    expect(aggregateTokens(withChainBalance('6000000000000000000', raised))).toHaveLength(1);
  });

  it('leaves it out of the totals rather than counting it at zero', () => {
    const totals = calculateTotals(aggregateTokens(withChainBalance('1')), []);

    expect(totals.totalUsd).toBe(0);
  });

  it('applies to exchange balances too', () => {
    const input = buildInput({
      exchangeBalances: [
        { id: 'kraken-1:BTC', accountId: 'kraken-1', asset: 'BTC', amount: '0.0000001', updatedAt: 0 },
      ],
      exchangeAccounts: [{ id: 'kraken-1', label: 'Kraken', exchange: 'kraken' }],
      exchangeAssetCoingeckoIds: { BTC: 'bitcoin' },
      prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: 0 }],
    });

    expect(aggregateTokens(input)).toHaveLength(0);
  });

  it('applies to manual holdings too', () => {
    const input = buildInput({
      manualHoldings: [
        {
          balance: { id: 'b1', symbol: 'BTC', location: 'Bitcoin', coingeckoId: 'bitcoin', createdAt: 0, enabled: 1 },
          amount: 0.0000001,
          entryCount: 1,
        },
      ],
      prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: 0 }],
    });

    expect(aggregateTokens(input)).toHaveLength(0);
  });
});
