import type { StoredCoinFamilyMap } from 'lib/prices/coin-families';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let storedSettings = new Map<string, unknown>();
const coinGeckoRequest = vi.fn();

// The settings table is a plain map, so each test reads back exactly what the refresh wrote.
vi.mock('lib/db', () => ({
  db: {
    settings: {
      get: async (key: string) => (storedSettings.has(key) ? { key, value: storedSettings.get(key) } : undefined),
      put: async (row: { key: string; value: unknown }) => {
        storedSettings.set(row.key, row.value);
      },
    },
  },
}));

vi.mock('lib/prices/coingecko', () => ({
  coinGeckoRequest: (...args: unknown[]) => coinGeckoRequest(...args),
}));

const { COIN_FAMILY_MAP_SETTING_KEY, refreshCoinFamilyMap } = await import('lib/prices/coin-families');

interface MarketEntry {
  id: string;
  symbol: string;
  current_price: number | null;
}

const ORIGINAL_PRICES: MarketEntry[] = [
  { id: 'weth', symbol: 'weth', current_price: 2720 },
  { id: 'usd-coin', symbol: 'usdc', current_price: 1 },
  { id: 'tether', symbol: 'usdt', current_price: 1 },
  { id: 'dai', symbol: 'dai', current_price: 1 },
  { id: 'wrapped-bitcoin', symbol: 'wbtc', current_price: 84_000 },
  { id: 'wrapped-steth', symbol: 'wsteth', current_price: 3385 },
  { id: 'frax', symbol: 'frax', current_price: 0.9926 },
  { id: 'wrapped-avax', symbol: 'wavax', current_price: 10.47 },
  { id: 'wbnb', symbol: 'wbnb', current_price: 773.43 },
  { id: 'wrapped-eeth', symbol: 'weeth', current_price: 2995.91 },
  { id: 'paypal-usd', symbol: 'pyusd', current_price: 0.99996 },
  { id: 'ripple', symbol: 'xrp', current_price: 1.61 },
  { id: 'solana', symbol: 'sol', current_price: 120.44 },
];

// Shaped after what CoinGecko really files under these categories, including the entries that must not merge.
const CATEGORY_MEMBERS: Record<string, MarketEntry[]> = {
  'bridged-weth': [
    { id: 'l2-standard-bridged-weth-base', symbol: 'weth', current_price: 2717.64 },
    { id: 'arbitrum-bridged-weth-arbitrum-one', symbol: 'weth', current_price: 2717.64 },
    // Drained bridge.
    { id: 'multichain-bridged-weth-fantom', symbol: 'weth', current_price: 17.95 },
    // A different asset filed under the wrong category.
    { id: 'polygon-bridged-weeth-katana', symbol: 'weeth', current_price: 3002.39 },
    // Nothing to check the peg against.
    { id: 'unpriced-bridged-weth', symbol: 'weth', current_price: null },
  ],
  'bridged-usdc': [
    { id: 'arbitrum-bridged-usdc-arbitrum', symbol: 'usdc', current_price: 0.9998 },
    { id: 'bridged-usd-coin-base', symbol: 'usdbc', current_price: 1.0001 },
    // Filed under both stablecoins and priced like both.
    { id: 'ambiguous-bridged-stablecoin', symbol: 'usdx', current_price: 1 },
  ],
  'bridged-usdt': [
    { id: 'arbitrum-bridged-usdt-arbitrum', symbol: 'usdt', current_price: 1 },
    { id: 'ambiguous-bridged-stablecoin', symbol: 'usdx', current_price: 1 },
    // WBTC.e really is filed here, and its price is what keeps it out.
    { id: 'citrea-bridged-wbtc-citrea', symbol: 'wbtc.e', current_price: 84_623 },
    // Filed as a copy of USDT while trading under USDC's symbol.
    { id: 'misfiled-bridged-usdc', symbol: 'usdc', current_price: 1 },
  ],
  'bridged-dai': [{ id: 'l2-standard-bridged-dai-base', symbol: 'dai', current_price: 0.9999 }],
  'bridged-wbtc': [{ id: 'citrea-bridged-wbtc-citrea', symbol: 'wbtc.e', current_price: 84_623 }],
  // An original listed in another family's category must never become a copy of anything.
  'bridged-wsteth': [{ id: 'weth', symbol: 'weth', current_price: 3385 }],
  'bridged-frax': [{ id: 'rainbow-bridged-frax-near-protocol', symbol: 'frax', current_price: 0.9917 }],
  // Thinly traded, and priced 6% above WAVAX.
  'bridged-wavax': [{ id: 'celer-bridged-wavax-linea', symbol: 'wavax', current_price: 11.09 }],
  'bridged-wbnb': [{ id: 'opbnb-bridged-wbnb-opbnb', symbol: 'wbnb', current_price: 774.87 }],
  'bridged-tokens': [
    // Left out of Bridged WETH, and the largest WETH copy of all.
    { id: 'binance-peg-weth', symbol: 'weth', current_price: 2719.1 },
    // Also in Bridged WETH, so claimed twice by the same original.
    { id: 'l2-standard-bridged-weth-base', symbol: 'weth', current_price: 2717.64 },
    // weETH has no category of its own.
    { id: 'arbitrum-bridged-wrapped-eeth', symbol: 'weeth', current_price: 2987.88 },
    // The symbol matches, but the market does not treat it as SOL.
    { id: 'neonpass-bridged-sol-neon-evm', symbol: 'sol', current_price: 138.03 },
    // No family trades under this symbol.
    { id: 'spx6900', symbol: 'spx', current_price: 0.45 },
    { id: 'misfiled-bridged-usdc', symbol: 'usdc', current_price: 1 },
  ],
  'bridged-stablecoins': [{ id: 'layerzero-bridged-pyusd0', symbol: 'pyusd0', current_price: 0.99993 }],
  'binance-peg-tokens': [
    { id: 'binance-peg-xrp', symbol: 'xrp', current_price: 1.61 },
    { id: 'binance-peg-sol', symbol: 'sol', current_price: 120 },
  ],
};

const respondLikeCoinGecko = async (_path: string, query: Record<string, string>) => {
  if (query.ids) return ORIGINAL_PRICES.filter((coin) => query.ids.split(',').includes(coin.id));
  return CATEGORY_MEMBERS[query.category] ?? [];
};

const storedMap = () => storedSettings.get(COIN_FAMILY_MAP_SETTING_KEY) as StoredCoinFamilyMap | undefined;

beforeEach(() => {
  storedSettings = new Map();
  coinGeckoRequest.mockReset();
  coinGeckoRequest.mockImplementation(respondLikeCoinGecko);
});

describe('refreshCoinFamilyMap', () => {
  it('maps healthy bridged copies to the coin they are a copy of', async () => {
    await refreshCoinFamilyMap();

    expect(storedMap()?.canonicalCoinIds).toEqual({
      'l2-standard-bridged-weth-base': 'weth',
      'arbitrum-bridged-weth-arbitrum-one': 'weth',
      'binance-peg-weth': 'weth',
      'arbitrum-bridged-usdc-arbitrum': 'usd-coin',
      'bridged-usd-coin-base': 'usd-coin',
      'arbitrum-bridged-usdt-arbitrum': 'tether',
      'l2-standard-bridged-dai-base': 'dai',
      'citrea-bridged-wbtc-citrea': 'wrapped-bitcoin',
      'rainbow-bridged-frax-near-protocol': 'frax',
      'opbnb-bridged-wbnb-opbnb': 'wbnb',
      'arbitrum-bridged-wrapped-eeth': 'wrapped-eeth',
      'layerzero-bridged-pyusd0': 'paypal-usd',
      'binance-peg-xrp': 'ripple',
      'binance-peg-sol': 'solana',
    });
  });

  it('finds copies in the generic categories by the symbol they trade under', async () => {
    await refreshCoinFamilyMap();

    // A copy CoinGecko left out of its asset's own category.
    expect(storedMap()?.canonicalCoinIds['binance-peg-weth']).toBe('weth');
    // Copies of assets with no category of their own.
    expect(storedMap()?.canonicalCoinIds['arbitrum-bridged-wrapped-eeth']).toBe('wrapped-eeth');
    expect(storedMap()?.canonicalCoinIds['binance-peg-xrp']).toBe('ripple');
    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('spx6900');
  });

  it('still merges a copy its own category and its symbol both claim for the same original', async () => {
    await refreshCoinFamilyMap();

    expect(storedMap()?.canonicalCoinIds['l2-standard-bridged-weth-base']).toBe('weth');
  });

  it('leaves out copies the market no longer prices like the original', async () => {
    await refreshCoinFamilyMap();

    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('multichain-bridged-weth-fantom');
    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('polygon-bridged-weeth-katana');
    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('unpriced-bridged-weth');
    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('celer-bridged-wavax-linea');
    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('neonpass-bridged-sol-neon-evm');
  });

  // Stablecoins cannot be told apart by price, so a coin claimed by two of them is left alone.
  it('leaves out a copy that passes for two different originals', async () => {
    await refreshCoinFamilyMap();

    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('ambiguous-bridged-stablecoin');
  });

  it('leaves out a copy whose category and symbol point at different originals', async () => {
    await refreshCoinFamilyMap();

    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('misfiled-bridged-usdc');
  });

  it('never turns an original into a copy of another coin', async () => {
    await refreshCoinFamilyMap();

    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('weth');
  });

  it('keeps the previous map when a request fails', async () => {
    const previous: StoredCoinFamilyMap = { canonicalCoinIds: { 'old-copy': 'weth' }, updatedAt: 0 };
    storedSettings.set(COIN_FAMILY_MAP_SETTING_KEY, previous);
    coinGeckoRequest.mockRejectedValue(new Error('rate limited'));

    await refreshCoinFamilyMap();

    expect(storedMap()).toEqual(previous);
  });

  // With no price to check its copies against, dropping them would split the family's rows apart until the
  // price comes back. One missing price must not hold up every other family either.
  it("keeps a family's previous copies when its original comes back without a price", async () => {
    storedSettings.set(COIN_FAMILY_MAP_SETTING_KEY, {
      canonicalCoinIds: {
        'old-dai-copy': 'dai',
        'old-weth-copy': 'weth',
        'copy-of-a-retired-family': 'retired-coin',
      },
      updatedAt: 0,
    } satisfies StoredCoinFamilyMap);
    coinGeckoRequest.mockImplementation(async (path: string, query: Record<string, string>) =>
      query.ids ? ORIGINAL_PRICES.filter((coin) => coin.id !== 'dai') : respondLikeCoinGecko(path, query),
    );

    await refreshCoinFamilyMap();

    expect(storedMap()?.canonicalCoinIds['old-dai-copy']).toBe('dai');
    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('l2-standard-bridged-dai-base');
    // Every family that could be checked was refreshed.
    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('old-weth-copy');
    expect(storedMap()?.canonicalCoinIds['l2-standard-bridged-weth-base']).toBe('weth');
    expect(storedMap()?.canonicalCoinIds).not.toHaveProperty('copy-of-a-retired-family');
  });

  it('does not refetch a map that is still fresh', async () => {
    storedSettings.set(COIN_FAMILY_MAP_SETTING_KEY, { canonicalCoinIds: {}, updatedAt: Date.now() });

    await refreshCoinFamilyMap();

    expect(coinGeckoRequest).not.toHaveBeenCalled();
  });
});
