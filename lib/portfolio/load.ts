import { createEnabledChainFilter } from 'lib/chains/enabled';
import { db } from 'lib/db';
import type {
  StoredBalance,
  StoredExchangeAccount,
  StoredExchangeBalance,
  StoredNftCollection,
  StoredNftItem,
  StoredPrice,
  StoredSetting,
  StoredToken,
  StoredTokenOverride,
} from 'lib/db/schema';
import { FIAT_RATES_SETTING_KEY, type StoredFiatRates } from 'lib/fiat/rates';
import type { AggregationInput } from 'lib/portfolio/aggregate';
import { ASSET_MAP_SETTING_KEY, type StoredAssetMap } from 'lib/prices/assets';
import { type AppSettings, DEFAULT_SETTINGS } from 'lib/settings/types';

// Everything the portfolio is derived from, straight out of IndexedDB and unfiltered.
export interface PortfolioSource {
  balances: StoredBalance[];
  tokens: StoredToken[];
  prices: StoredPrice[];
  overrides: StoredTokenOverride[];
  nftCollections: StoredNftCollection[];
  nftItems: StoredNftItem[];
  exchangeBalances: StoredExchangeBalance[];
  exchangeAccounts: StoredExchangeAccount[];
  settingsRow?: StoredSetting;
  assetMapRow?: StoredSetting;
  fiatRatesRow?: StoredSetting;
}

export const PORTFOLIO_SETTINGS_KEY = 'app-settings';

// Reads the source tables once.
//
// The dashboard reads the same tables through a live query so it re-renders on every write; this is for
// callers outside React, which today means recording a snapshot at the end of a sync. Both then go through
// `buildAggregationInput` below, so the chart's newest point and the headline figure above it can never be
// computed two different ways.
export const loadPortfolioSource = async (): Promise<PortfolioSource> => {
  const [
    balances,
    tokens,
    prices,
    overrides,
    nftCollections,
    nftItems,
    exchangeBalances,
    exchangeAccounts,
    settingsRow,
    assetMapRow,
    fiatRatesRow,
  ] = await Promise.all([
    db.balances.toArray(),
    db.tokens.toArray(),
    db.prices.toArray(),
    db.tokenOverrides.toArray(),
    db.nftCollections.toArray(),
    db.nftItems.toArray(),
    db.exchangeBalances.toArray(),
    db.exchangeAccounts.toArray(),
    db.settings.get(PORTFOLIO_SETTINGS_KEY),
    db.settings.get(ASSET_MAP_SETTING_KEY),
    db.settings.get(FIAT_RATES_SETTING_KEY),
  ]);

  return {
    balances,
    tokens,
    prices,
    overrides,
    nftCollections,
    nftItems,
    exchangeBalances,
    exchangeAccounts,
    settingsRow,
    assetMapRow,
    fiatRatesRow,
  };
};

// Applies the user's settings to the raw rows: which chains count, which exchange accounts count, and how
// tickers and icons are resolved.
export const buildAggregationInput = (source: PortfolioSource): AggregationInput => {
  const storedSettings = source.settingsRow?.value as Partial<AppSettings> | undefined;
  const spamSettings = storedSettings?.spam ?? DEFAULT_SETTINGS.spam;

  // Disabling a chain hides everything already synced from it, not just future syncs. The rows stay in
  // IndexedDB untouched, so re-enabling the chain brings them straight back with no re-sync.
  const isChainEnabled = createEnabledChainFilter({ ...DEFAULT_SETTINGS.sync, ...storedSettings?.sync });

  const assetMap = source.assetMapRow?.value as StoredAssetMap | undefined;
  const symbolMap = assetMap?.symbols ?? {};

  // Disabling an exchange account hides what is on it, exactly as disabling a chain does. Without this the
  // balances stay in the totals, hidden inside a token row where the discrepancy is hard to spot.
  const exchangeAccounts = source.exchangeAccounts.filter((account) => account.enabled === 1);
  const enabledAccountIds = new Set(exchangeAccounts.map((account) => account.id));
  const exchangeBalances = source.exchangeBalances.filter((balance) => enabledAccountIds.has(balance.accountId));

  // The stored map is keyed by lowercase symbol; aggregation looks assets up by their uppercase ticker.
  const exchangeAssetCoingeckoIds = Object.fromEntries(
    exchangeBalances
      .map((balance) => [balance.asset, symbolMap[balance.asset.toLowerCase()]])
      .filter(([, id]) => Boolean(id)),
  ) as Record<string, string>;

  return {
    balances: source.balances.filter((balance) => isChainEnabled(balance.chainId)),
    tokens: source.tokens,
    prices: source.prices,
    overrides: source.overrides,
    nftCollections: source.nftCollections.filter((collection) => isChainEnabled(collection.chainId)),
    nftItems: source.nftItems.filter((item) => isChainEnabled(item.chainId)),
    exchangeBalances,
    exchangeAccounts,
    exchangeAssetCoingeckoIds,
    coinLogoUrls: assetMap?.logos,
    fiatRatesPerUsd: (source.fiatRatesRow?.value as StoredFiatRates | undefined)?.rates,
    spamSettings,
  };
};
