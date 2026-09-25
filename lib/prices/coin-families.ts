import { db } from 'lib/db';
import { coinGeckoRequest } from 'lib/prices/coingecko';
import { groupBy, isNullish } from 'lib/utils';
import { DAY } from 'lib/utils/time';

interface CoinGeckoMarketEntry {
  id: string;
  symbol?: string;
  current_price?: number | null;
}

export const COIN_FAMILY_MAP_SETTING_KEY = 'coingecko-coin-families';
const COIN_FAMILY_MAP_MAX_AGE = 1 * DAY;

export interface StoredCoinFamilyMap {
  // A bridged copy's coin id to the coin id of the asset it is a copy of.
  canonicalCoinIds: Record<string, string>;
  updatedAt: number;
}

interface CoinFamily {
  // The coin its copies are grouped under.
  coinId: string;
  // CoinGecko's category for copies of this coin, for the assets that have one.
  bridgedCategoryId?: string;
  // The lowercase symbols its copies trade under, only ever matched within the generic bridged categories.
  symbols: string[];
}

// The assets CoinGecko lists once per bridge.
//
// Most tokens have one coin id however many chains they are deployed on, which is what lets LINK on five
// chains be one row. Bridged assets are the exception: WETH alone has around seventy coin ids, one per
// chain and bridge, and DAI's own listing covers Ethereum only. Grouping on coin id alone then shows the same
// asset once per chain.
//
// Nine assets have a bridged category of their own, which is where CoinGecko records which asset a copy is a
// copy of. Copies of everything else, and copies CoinGecko left out of those nine, are found by symbol in the
// generic bridged categories.
//
// A copy of a chain's native coin joins its wrapped form where there is one: WETH, WAVAX and WBNB are ETH,
// AVAX and BNB as a token, which is also how CoinGecko files them.
const COIN_FAMILIES: CoinFamily[] = [
  { coinId: 'weth', bridgedCategoryId: 'bridged-weth', symbols: ['weth', 'eth', 'vbeth'] },
  { coinId: 'usd-coin', bridgedCategoryId: 'bridged-usdc', symbols: ['usdc', 'usdc.e', 'usdbc'] },
  { coinId: 'tether', bridgedCategoryId: 'bridged-usdt', symbols: ['usdt', 'usdt.e', 'usdt0'] },
  { coinId: 'dai', bridgedCategoryId: 'bridged-dai', symbols: ['dai'] },
  { coinId: 'wrapped-bitcoin', bridgedCategoryId: 'bridged-wbtc', symbols: ['wbtc', 'wbtc.e'] },
  { coinId: 'wrapped-steth', bridgedCategoryId: 'bridged-wsteth', symbols: ['wsteth'] },
  // The legacy Frax Dollar stablecoin, which is what CoinGecko's bridged FRAX category holds. Since the
  // rebrand, the token trading as FRAX is the former FXS (`frax-share`), a different asset altogether. Its
  // copies share the symbol, and the price check is what keeps them out.
  { coinId: 'frax', bridgedCategoryId: 'bridged-frax', symbols: ['frax'] },
  { coinId: 'wrapped-avax', bridgedCategoryId: 'bridged-wavax', symbols: ['wavax', 'avax'] },
  { coinId: 'wbnb', bridgedCategoryId: 'bridged-wbnb', symbols: ['wbnb', 'bnb'] },
  { coinId: 'wrapped-eeth', symbols: ['weeth'] },
  { coinId: 'tether-gold', symbols: ['xaut', 'xaut0'] },
  { coinId: 'paypal-usd', symbols: ['pyusd', 'pyusd0'] },
  { coinId: 'true-usd', symbols: ['tusd'] },
  { coinId: 'binance-usd', symbols: ['busd'] },
  { coinId: 'shiba-inu', symbols: ['shib'] },
  // Coins native to chains we do not sync. Their copies, mostly Binance-Peg tokens on BNB Chain, join what is
  // held of the real coin on an exchange or by hand. WBTC is one custodian's copy of BTC rather than BTC as a
  // token, so other copies of BTC, like BTC.b, join BTC and not WBTC.
  { coinId: 'bitcoin', symbols: ['btc', 'btc.b', 'btcb'] },
  { coinId: 'ripple', symbols: ['xrp', 'fxrp'] },
  { coinId: 'zcash', symbols: ['zec'] },
  { coinId: 'dogecoin', symbols: ['doge'] },
  { coinId: 'solana', symbols: ['sol'] },
  { coinId: 'cardano', symbols: ['ada'] },
  { coinId: 'near', symbols: ['near'] },
  { coinId: 'litecoin', symbols: ['ltc'] },
  { coinId: 'bitcoin-cash', symbols: ['bch'] },
  { coinId: 'polkadot', symbols: ['dot'] },
  { coinId: 'filecoin', symbols: ['fil'] },
];

// Categories of bridged copies of many different assets, where only the symbol says which asset.
//
// Matching on a symbol is exactly what the rest of the app refuses to do, because anyone can deploy a token
// called USDC. It is safe here because CoinGecko has already listed the coin as a bridged copy, which an
// impostor cannot arrange, so the symbol is only asked which asset it is a copy of. The price check still has
// the final say, and a wrong answer could only ever move a holding into another row, never change its value.
const GENERIC_BRIDGED_CATEGORY_IDS = ['bridged-tokens', 'bridged-stablecoins', 'binance-peg-tokens'];

// How far a copy's price may sit from the original's for the copy to count as the same asset.
//
// The categories are not exact enough to trust on their own. They list copies from bridges that were
// drained (Multichain WETH trades at under 1% of ETH) and coins filed under the wrong asset (weETH under
// WETH, WBTC.e under USDT). A copy the market prices like the original is one the market treats as the
// original; anything else keeps a row of its own. Healthy copies sit well inside this, mostly within a tenth
// of a percent.
const MAX_PRICE_DEVIATION = 0.02;

const MARKET_PAGE_SIZE = 250;
// The largest category, Bridged Tokens, has around 480 coins. The bound only guards against paging forever.
const MAX_MARKET_PAGES = 4;

// A coin CoinGecko has a price for.
interface MarketCoin {
  coinId: string;
  symbol: string;
  priceUsd: number;
}

// A coin that one of the categories says is a copy of an original, before its price is checked.
interface CopyClaim extends MarketCoin {
  canonicalCoinId: string;
}

// Refreshes the map if it is stale. Called during a sync, alongside the other CoinGecko maps, so that the
// grouping is settled before a snapshot is recorded from it.
//
// A failed refresh keeps whatever we already had. That is safe even if a bridge has been drained since,
// because a copy is always valued at its own price: a stale entry can put a holding in the wrong row, but
// never give it the wrong value.
export const refreshCoinFamilyMap = async (): Promise<void> => {
  const stored = (await db.settings.get(COIN_FAMILY_MAP_SETTING_KEY))?.value as StoredCoinFamilyMap | undefined;
  if (stored && Date.now() - stored.updatedAt < COIN_FAMILY_MAP_MAX_AGE) return;

  const canonicalCoinIds = await fetchCanonicalCoinIds(stored?.canonicalCoinIds ?? {}).catch(() => null);
  if (!canonicalCoinIds) return;

  const value: StoredCoinFamilyMap = { canonicalCoinIds, updatedAt: Date.now() };
  await db.settings.put({ key: COIN_FAMILY_MAP_SETTING_KEY, value });
};

const fetchCanonicalCoinIds = async (
  previousCanonicalCoinIds: Record<string, string>,
): Promise<Record<string, string>> => {
  const originalCoinIds = COIN_FAMILIES.map((family) => family.coinId);
  const originalCoins = await fetchMarketCoins({ ids: originalCoinIds.join(',') });
  const originalPrices = new Map(originalCoins.map((coin) => [coin.coinId, coin.priceUsd]));

  const claims = await fetchCopyClaims();

  const checkedClaims = claims
    .filter((claim) => !originalCoinIds.includes(claim.coinId))
    .filter((claim) => {
      const originalPrice = originalPrices.get(claim.canonicalCoinId);
      return !isNullish(originalPrice) && Math.abs(claim.priceUsd / originalPrice - 1) <= MAX_PRICE_DEVIATION;
    });

  // A coin is often claimed more than once by the same original, by its own category and again by its symbol
  // in a generic one. A coin claimed by two different originals and priced like both can only be told apart
  // by its price when the originals differ, which stablecoins do not. Rather than guess, it keeps a row of
  // its own.
  const checkedCanonicalCoinIds = Object.fromEntries(
    [...groupBy(checkedClaims, (claim) => claim.coinId).entries()]
      .map(([coinId, coinClaims]) => [coinId, [...new Set(coinClaims.map((claim) => claim.canonicalCoinId))]] as const)
      .filter(([, canonicalCoinIds]) => canonicalCoinIds.length === 1)
      .map(([coinId, [canonicalCoinId]]) => [coinId, canonicalCoinId]),
  );

  // Without the original's price no copy of it can be checked. That family keeps the copies it had, rather
  // than splitting its rows apart until the price comes back, and the rest of the map refreshes as usual.
  const uncheckedCanonicalCoinIds = Object.fromEntries(
    Object.entries(previousCanonicalCoinIds).filter(
      ([, canonicalCoinId]) => originalCoinIds.includes(canonicalCoinId) && !originalPrices.has(canonicalCoinId),
    ),
  );

  return { ...uncheckedCanonicalCoinIds, ...checkedCanonicalCoinIds };
};

// Every coin a category says is a copy of one of the originals: all of a family's own category, and the
// coins in the generic categories whose symbol a family claims.
const fetchCopyClaims = async (): Promise<CopyClaim[]> => {
  const familyCoinIdsBySymbol = new Map(
    COIN_FAMILIES.flatMap((family) => family.symbols.map((symbol) => [symbol, family.coinId] as const)),
  );

  const sources = [
    ...COIN_FAMILIES.flatMap((family) =>
      family.bridgedCategoryId
        ? [{ categoryId: family.bridgedCategoryId, resolveOriginal: (): string | undefined => family.coinId }]
        : [],
    ),
    ...GENERIC_BRIDGED_CATEGORY_IDS.map((categoryId) => ({
      categoryId,
      resolveOriginal: (coin: MarketCoin): string | undefined => familyCoinIdsBySymbol.get(coin.symbol),
    })),
  ];

  const claimsBySource = await Promise.all(
    sources.map(async (source) => {
      const coins = await fetchMarketCoins({ category: source.categoryId });

      return coins.flatMap((coin) => {
        const canonicalCoinId = source.resolveOriginal(coin);
        return canonicalCoinId ? [{ ...coin, canonicalCoinId }] : [];
      });
    }),
  );

  return claimsBySource.flat();
};

// Every coin the query matches that CoinGecko has a price for.
const fetchMarketCoins = async (query: Record<string, string>): Promise<MarketCoin[]> => {
  const coins: MarketCoin[] = [];

  for (let page = 1; page <= MAX_MARKET_PAGES; page += 1) {
    const entries = await coinGeckoRequest<CoinGeckoMarketEntry[]>('/coins/markets', {
      vs_currency: 'usd',
      per_page: String(MARKET_PAGE_SIZE),
      page: String(page),
      ...query,
    });

    for (const entry of entries) {
      if (isNullish(entry.current_price)) continue;
      coins.push({ coinId: entry.id, symbol: entry.symbol?.toLowerCase() ?? '', priceUsd: entry.current_price });
    }

    if (entries.length < MARKET_PAGE_SIZE) break;
  }

  return coins;
};
