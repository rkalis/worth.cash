'use client';

import NftCollectionTable from 'components/portfolio/NftCollectionTable';
import PortfolioSummary from 'components/portfolio/PortfolioSummary';
import TokenTable from 'components/portfolio/TokenTable';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import type { Portfolio } from 'lib/hooks/usePortfolio';
import { useState } from 'react';

interface Props {
  portfolio: Portfolio;
}

// The dashboard below the chart: summary tiles, the asset table, and the NFT table.
//
// One component fed either the live portfolio or a pinned snapshot's, assembled through the same
// aggregation. That identity is deliberate: pinning a point must show exactly what the dashboard would
// have shown, and the only way to guarantee that is to render it with the same components.
const PortfolioSections = ({ portfolio }: Props) => {
  const [showHidden, setShowHidden] = useState(false);
  const [showHiddenNfts, setShowHiddenNfts] = useState(false);

  return (
    <>
      <PortfolioSummary
        totals={portfolio.totals}
        tokenChainBreakdown={portfolio.tokenChainBreakdown}
        nftChainBreakdown={portfolio.nftChainBreakdown}
        exchangeBreakdown={portfolio.exchangeBreakdown}
        manualBreakdown={portfolio.manualBreakdown}
      />

      <Card
        title={`Assets (${portfolio.visibleTokens.length})`}
        action={
          portfolio.hiddenTokens.length > 0 ? (
            <Button variant="tertiary" size="sm" onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? 'Hide' : 'Show'} {portfolio.hiddenTokens.length} filtered
            </Button>
          ) : null
        }
        bodyClassName="p-0"
      >
        <TokenTable
          tokens={portfolio.visibleTokens}
          totalValueUsd={portfolio.totals.totalUsd}
          emptyTitle="No balances found"
          emptyDescription="Add a wallet, an exchange account, or a manual balance in settings and run a sync, or loosen the spam filters if you expect to see something here."
        />
      </Card>

      {showHidden && portfolio.hiddenTokens.length > 0 ? (
        <Card title="Filtered out" bodyClassName="p-0">
          <p className="px-4 pt-3 pb-1 text-xs text-zinc-500">
            Hidden by your spam and dust settings. Nothing here counts towards your total.
          </p>
          {/* No share column here: these positions are excluded from the total by design, so a percentage
              of it would be a fraction of something they are not part of. */}
          <TokenTable tokens={portfolio.hiddenTokens} totalValueUsd={0} />
        </Card>
      ) : null}

      {portfolio.nftCollections.length > 0 ? (
        <Card
          title={`NFTs (${portfolio.visibleNftCollections.length})`}
          action={
            portfolio.hiddenNftCollections.length > 0 ? (
              <Button variant="tertiary" size="sm" onClick={() => setShowHiddenNfts(!showHiddenNfts)}>
                {showHiddenNfts ? 'Hide' : 'Show'} {portfolio.hiddenNftCollections.length} filtered
              </Button>
            ) : null
          }
          bodyClassName="p-0"
        >
          <NftCollectionTable
            collections={showHiddenNfts ? portfolio.nftCollections : portfolio.visibleNftCollections}
            totalValueUsd={portfolio.totals.totalUsd}
          />
        </Card>
      ) : null}
    </>
  );
};

export default PortfolioSections;
