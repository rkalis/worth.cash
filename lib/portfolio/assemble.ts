import {
  type AggregatedNftCollection,
  type AggregatedToken,
  type AggregationInput,
  aggregateNftCollections,
  aggregateTokens,
  calculateTotals,
  type PortfolioTotals,
} from 'lib/portfolio/aggregate';
import {
  type BreakdownEntry,
  buildExchangeBreakdown,
  buildManualBreakdown,
  buildNftChainBreakdown,
  buildTokenChainBreakdown,
} from 'lib/portfolio/breakdown';

export interface AssembledPortfolio {
  tokens: AggregatedToken[];
  visibleTokens: AggregatedToken[];
  hiddenTokens: AggregatedToken[];
  nftCollections: AggregatedNftCollection[];
  visibleNftCollections: AggregatedNftCollection[];
  hiddenNftCollections: AggregatedNftCollection[];
  totals: PortfolioTotals;
  tokenChainBreakdown: BreakdownEntry[];
  nftChainBreakdown: BreakdownEntry[];
  exchangeBreakdown: BreakdownEntry[];
  manualBreakdown: BreakdownEntry[];
}

// Everything the portfolio views derive from one aggregation input.
//
// Extracted from the live hook so a pinned snapshot assembles through the identical path: same
// aggregation, same visibility split, same breakdowns. One definition of what a portfolio looks like,
// fed either the present or a frozen past.
export const assemblePortfolio = (input: AggregationInput): AssembledPortfolio => {
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
    manualBreakdown: buildManualBreakdown(visibleTokens),
  };
};
