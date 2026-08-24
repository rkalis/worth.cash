import type { StoredBalance, StoredSetting, StoredToken } from 'lib/db/schema';
import { describe, expect, it, vi } from 'vitest';

vi.mock('lib/db', () => ({ db: {} }));

const { buildAggregationInput } = await import('lib/portfolio/load');
const { aggregateTokens, calculateTotals } = await import('lib/portfolio/aggregate');

const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x00000000000000000000000000000000000000aa';

// A settings row exactly as it was written before `dustThresholdAmount` and `display.currency` existed.
const LEGACY_SETTINGS_ROW: StoredSetting = {
  key: 'app-settings',
  value: {
    apiKeys: {},
    coingeckoTier: 'auto',
    rpcOverrides: {},
    sync: { enabledChainIds: null, includeTestnets: false, chainConcurrency: 4, refreshIntervalMinutes: 30 },
    spam: { dustThresholdUsd: 1, hideUnpricedTokens: true, useSpamHeuristics: true },
  },
};

const sourceWithOneEther = (settingsRow?: StoredSetting) => ({
  balances: [
    {
      id: `1:${OWNER}:${TOKEN}`,
      chainId: 1,
      owner: OWNER,
      token: TOKEN,
      standard: 'erc20',
      amount: '1000000000000000000',
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
  overrides: [],
  nftCollections: [],
  nftItems: [],
  exchangeBalances: [],
  exchangeAccounts: [],
  manualBalances: [],
  manualLedger: [],
  categoryAssignments: [],
  settingsRow,
});

// A settings row written before a field existed is present but incomplete, which is not the same thing as
// missing. Reading its `spam` section straight out of the row left the new minimum-balance threshold
// undefined, every `amount >= undefined` was false, and a portfolio of real holdings aggregated to nothing.
describe('a settings row written by an earlier version', () => {
  it('still counts holdings when the stored spam section predates the minimum balance', () => {
    const input = buildAggregationInput(sourceWithOneEther(LEGACY_SETTINGS_ROW));

    expect(input.spamSettings.dustThresholdAmount).toBe(0.000001);

    const tokens = aggregateTokens(input);
    expect(tokens).toHaveLength(1);
    expect(calculateTotals(tokens, []).tokensUsd).toBe(1000);
  });

  it('keeps the settings it does carry rather than resetting them to the defaults', () => {
    const input = buildAggregationInput(sourceWithOneEther(LEGACY_SETTINGS_ROW));

    expect(input.spamSettings.dustThresholdUsd).toBe(1);
    expect(input.spamSettings.hideUnpricedTokens).toBe(true);
  });

  it('counts holdings when there is no settings row at all', () => {
    const tokens = aggregateTokens(buildAggregationInput(sourceWithOneEther()));

    expect(calculateTotals(tokens, []).tokensUsd).toBe(1000);
  });
});
