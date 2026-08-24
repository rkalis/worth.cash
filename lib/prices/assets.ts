import { db } from 'lib/db';
import { coinGeckoRequest, toAbsoluteCoinGeckoImageUrl } from 'lib/prices/coingecko';
import { DAY } from 'lib/utils/time';

interface CoinGeckoMarketEntry {
  id: string;
  symbol: string;
  name: string;
  image?: string | null;
  market_cap?: number | null;
}

export const ASSET_MAP_SETTING_KEY = 'coingecko-asset-map';
const ASSET_MAP_MAX_AGE = 1 * DAY;

// How many coins to pull, most valuable first. Exchange-listed assets are overwhelmingly within the top few
// hundred by market cap, and every extra page costs a request against a tight rate limit.
const MARKET_PAGES = 3;
const MARKET_PAGE_SIZE = 250;

// Two lookups built from one response: a ticker to coin id map, and an icon per coin id.
//
// The icon half exists because an exchange reports a ticker and an amount and nothing else. There is no
// contract to look up in the whois dataset, so this market data is the only place a picture of BTC or SOL
// can come from, and it is already being fetched to price them.
export interface StoredAssetMap {
  // Lowercase ticker to CoinGecko coin id.
  symbols: Record<string, string>;
  // Lowercase coin name to CoinGecko coin id. This is what lets a manual balance's location be given an
  // icon: someone holding coins on "Bitcoin Cash" named a chain whose native coin is called exactly that,
  // so the name is the link between a place the app knows nothing about and a picture of it.
  names: Record<string, string>;
  // CoinGecko coin id to icon URL.
  logos: Record<string, string>;
  updatedAt: number;
}

// Exchanges report holdings by ticker, but CoinGecko prices by id, and tickers are not unique: dozens of
// worthless tokens claim symbols like SOL or APE. Resolving through a market-cap-ordered list means the
// symbol always maps to the asset an exchange would actually be listing, rather than to an impostor that
// happens to appear first alphabetically.
export const resolveCoinGeckoIdsForSymbols = async (symbols: string[]): Promise<Map<string, string>> => {
  const { symbols: symbolMap } = await getAssetMap();

  const resolved = new Map<string, string>();
  for (const symbol of symbols) {
    const coingeckoId = symbolMap[symbol.toLowerCase()];
    if (coingeckoId) resolved.set(symbol.toUpperCase(), coingeckoId);
  }

  return resolved;
};

// Refreshes the map if it is stale. Called during a sync so that the icons and tickers a portfolio needs are
// present before anything tries to render them, rather than being fetched lazily from a component.
export const refreshAssetMap = async (): Promise<void> => {
  await getAssetMap();
};

const getAssetMap = async (): Promise<StoredAssetMap> => {
  const stored = (await db.settings.get(ASSET_MAP_SETTING_KEY))?.value as StoredAssetMap | undefined;

  // A map stored before it carried names is treated as stale rather than as usable, so the new lookup fills
  // itself in on next use instead of waiting out the day the old copy still had left.
  if (stored?.names && Date.now() - stored.updatedAt < ASSET_MAP_MAX_AGE) {
    return stored;
  }

  const fetched = await fetchAssetMap().catch(() => null);

  // A failed refresh falls back to whatever we already had. Stale mappings are still correct, since an
  // asset's CoinGecko id does not change.
  if (!fetched) return stored ?? { symbols: {}, names: {}, logos: {}, updatedAt: 0 };

  const value: StoredAssetMap = { ...fetched, updatedAt: Date.now() };
  await db.settings.put({ key: ASSET_MAP_SETTING_KEY, value });
  return value;
};

const fetchAssetMap = async (): Promise<Pick<StoredAssetMap, 'symbols' | 'names' | 'logos'>> => {
  const symbols: Record<string, string> = {};
  const names: Record<string, string> = {};
  const logos: Record<string, string> = {};

  for (let page = 1; page <= MARKET_PAGES; page += 1) {
    const entries = await coinGeckoRequest<CoinGeckoMarketEntry[]>('/coins/markets', {
      vs_currency: 'usd',
      order: 'market_cap_desc',
      per_page: String(MARKET_PAGE_SIZE),
      page: String(page),
    });

    for (const entry of entries) {
      const logoUrl = toAbsoluteCoinGeckoImageUrl(entry.image);
      if (logoUrl) logos[entry.id] = logoUrl;

      // Pages arrive in descending market cap order, so the first id seen for a name or symbol is the right
      // one and later collisions are ignored.
      const name = entry.name?.toLowerCase();
      if (name && !names[name]) names[name] = entry.id;

      const symbol = entry.symbol?.toLowerCase();
      if (!symbol) continue;

      if (!symbols[symbol]) symbols[symbol] = entry.id;
    }

    if (entries.length < MARKET_PAGE_SIZE) break;
  }

  return { symbols, names, logos };
};
