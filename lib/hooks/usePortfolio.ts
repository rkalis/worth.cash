'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import type { PortfolioTotals } from 'lib/portfolio/aggregate';
import { type AssembledPortfolio, assemblePortfolio } from 'lib/portfolio/assemble';
import { buildAggregationInput, loadPortfolioSource } from 'lib/portfolio/load';
import { useMemo } from 'react';

export interface Portfolio extends AssembledPortfolio {
  isLoading: boolean;
}

const EMPTY_TOTALS: PortfolioTotals = { tokensUsd: 0, nftsUsd: 0, exchangesUsd: 0, manualUsd: 0, totalUsd: 0 };

export const EMPTY_PORTFOLIO: Portfolio = {
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
  manualBreakdown: [],
  isLoading: true,
};

// Reads everything the portfolio is derived from and aggregates it.
//
// The read is a live query, so any write from the sync engine re-renders the affected views without the UI
// needing to know a sync happened. Aggregation is memoised separately from the read because it is the
// expensive half and the inputs change far less often than React re-renders.
//
// The reading and the filtering both live in lib/portfolio/load, and the assembly in lib/portfolio/assemble
// is shared with the pinned-snapshot view. That is what stops a snapshot being rendered by different rules
// than the live page: there is only one definition of what a portfolio looks like.
export const usePortfolio = (): Portfolio => {
  const source = useLiveQuery(() => loadPortfolioSource(), []);

  return useMemo(() => {
    if (!source) return EMPTY_PORTFOLIO;

    return { ...assemblePortfolio(buildAggregationInput(source)), isLoading: false };
  }, [source]);
};
