'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { createEnabledChainFilter } from 'lib/chains/enabled';
import { db } from 'lib/db';
import { FIAT_RATES_SETTING_KEY, type StoredFiatRates } from 'lib/fiat/rates';
import {
  type AggregatedNftCollection,
  type AggregatedToken,
  aggregateNftCollections,
  aggregateTokens,
  calculateTotals,
  type PortfolioTotals,
} from 'lib/portfolio/aggregate';
import {
  type BreakdownEntry,
  buildExchangeBreakdown,
  buildNftChainBreakdown,
  buildTokenChainBreakdown,
} from 'lib/portfolio/breakdown';
import { ASSET_MAP_SETTING_KEY, type StoredAssetMap } from 'lib/prices/assets';
import { DEFAULT_SETTINGS } from 'lib/settings/types';
import { useMemo } from 'react';

export interface Portfolio {
  tokens: AggregatedToken[];
  visibleTokens: AggregatedToken[];
  hiddenTokens: AggregatedToken[];
  nftCollections: AggregatedNftCollection[];
  visibleNftCollections: AggregatedNftCollection[];
  hiddenNftCollections: AggregatedNftCollection[];
  totals: PortfolioTotals;
  // Where the money actually sits, for the summary tiles. Built from the visible positions only, so the
  // figures reconcile with the totals above them.
  tokenChainBreakdown: BreakdownEntry[];
  nftChainBreakdown: BreakdownEntry[];
  exchangeBreakdown: BreakdownEntry[];
  isLoading: boolean;
}

const EMPTY_TOTALS: PortfolioTotals = { tokensUsd: 0, nftsUsd: 0, exchangesUsd: 0, totalUsd: 0 };

// Reads everything the portfolio is derived from and aggregates it.
//
// The reads are live queries, so any write from the sync engine re-renders the affected views without the
// UI needing to know a sync happened. Aggregation is memoised separately from the reads because it is the
// expensive half and the inputs change far less often than React re-renders.
export const usePortfolio = (): Portfolio => {
  const data = useLiveQuery(async () => {
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
      db.settings.get('app-settings'),
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
  }, []);

  return useMemo(() => {
    if (!data) {
      return {
        tokens: [],
        visibleTokens: [],
        hiddenTokens: [],
        nftCollections: [],
        visibleNftCollections: [],
        hiddenNftCollections: [],
        totals: EMPTY_TOTALS,
        tokenChainBreakdown: [],
        nftChainBreakdown: [],
        exchangeBreakdown: [],
        isLoading: true,
      };
    }

    const storedSettings = data.settingsRow?.value as Partial<typeof DEFAULT_SETTINGS> | undefined;
    const spamSettings = storedSettings?.spam ?? DEFAULT_SETTINGS.spam;

    // Disabling a chain hides everything already synced from it, not just future syncs. The rows stay in
    // IndexedDB untouched, so re-enabling the chain brings them straight back with no re-sync.
    const isChainEnabled = createEnabledChainFilter({ ...DEFAULT_SETTINGS.sync, ...storedSettings?.sync });

    const assetMap = data.assetMapRow?.value as StoredAssetMap | undefined;
    const symbolMap = assetMap?.symbols ?? {};

    // Disabling an exchange account hides what is on it, exactly as disabling a chain does. Without this the
    // balances stay in the totals, and after the merge they would be hidden inside a token row rather than
    // sitting in an exchange list where the discrepancy is at least visible.
    const enabledAccounts = data.exchangeAccounts.filter((account) => account.enabled === 1);
    const enabledAccountIds = new Set(enabledAccounts.map((account) => account.id));
    const exchangeBalances = data.exchangeBalances.filter((balance) => enabledAccountIds.has(balance.accountId));

    // The stored map is keyed by lowercase symbol; aggregation looks assets up by their uppercase ticker.
    const exchangeAssetCoingeckoIds = Object.fromEntries(
      exchangeBalances
        .map((balance) => [balance.asset, symbolMap[balance.asset.toLowerCase()]])
        .filter(([, id]) => Boolean(id)),
    ) as Record<string, string>;

    const input = {
      balances: data.balances.filter((balance) => isChainEnabled(balance.chainId)),
      tokens: data.tokens,
      prices: data.prices,
      overrides: data.overrides,
      nftCollections: data.nftCollections.filter((collection) => isChainEnabled(collection.chainId)),
      nftItems: data.nftItems.filter((item) => isChainEnabled(item.chainId)),
      exchangeBalances,
      exchangeAccounts: enabledAccounts,
      exchangeAssetCoingeckoIds,
      coinLogoUrls: assetMap?.logos,
      fiatRatesPerUsd: (data.fiatRatesRow?.value as StoredFiatRates | undefined)?.rates,
      spamSettings,
    };

    const tokens = aggregateTokens(input);
    const nftCollections = aggregateNftCollections(input);

    const visibleTokens = tokens.filter((token) => !token.isHidden);
    const visibleNftCollections = nftCollections.filter((collection) => !collection.isHidden);

    return {
      tokens,
      visibleTokens,
      hiddenTokens: tokens.filter((token) => token.isHidden),
      nftCollections,
      visibleNftCollections,
      hiddenNftCollections: nftCollections.filter((collection) => collection.isHidden),
      totals: calculateTotals(tokens, nftCollections),
      tokenChainBreakdown: buildTokenChainBreakdown(visibleTokens),
      nftChainBreakdown: buildNftChainBreakdown(visibleNftCollections),
      exchangeBreakdown: buildExchangeBreakdown(visibleTokens),
      isLoading: false,
    };
  }, [data]);
};
