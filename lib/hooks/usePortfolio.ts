'use client';

import { useLiveQuery } from 'dexie-react-hooks';
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
import { buildAggregationInput, loadPortfolioSource } from 'lib/portfolio/load';
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
// The read is a live query, so any write from the sync engine re-renders the affected views without the UI
// needing to know a sync happened. Aggregation is memoised separately from the read because it is the
// expensive half and the inputs change far less often than React re-renders.
//
// The reading and the filtering both live in lib/portfolio/load, and everything outside React uses the same
// two functions. That is what stops a snapshot being built from a different portfolio than the one on
// screen: there is only one definition of which chains, accounts and prices count.
export const usePortfolio = (): Portfolio => {
  const source = useLiveQuery(() => loadPortfolioSource(), []);

  return useMemo(() => {
    if (!source) {
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

    const input = buildAggregationInput(source);

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
  }, [source]);
};
