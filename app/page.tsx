'use client';

import NftCollectionTable from 'components/portfolio/NftCollectionTable';
import PortfolioSummary from 'components/portfolio/PortfolioSummary';
import PortfolioValue from 'components/portfolio/PortfolioValue';
import SyncBar from 'components/portfolio/SyncBar';
import TokenTable from 'components/portfolio/TokenTable';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import Spinner from 'components/ui/Spinner';
import { usePortfolio } from 'lib/hooks/usePortfolio';
import { useSnapshots } from 'lib/hooks/useSnapshots';
import Link from 'next/link';
import { useState } from 'react';

const DashboardPage = () => {
  const portfolio = usePortfolio();
  const history = useSnapshots();
  const [showHidden, setShowHidden] = useState(false);
  const [showHiddenNfts, setShowHiddenNfts] = useState(false);

  if (portfolio.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-zinc-500">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SyncBar />

      <PortfolioValue totalUsd={portfolio.totals.totalUsd} points={history.points} />

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
            <div className="flex items-center gap-3">
              {portfolio.hiddenNftCollections.length > 0 ? (
                <Button variant="tertiary" size="sm" onClick={() => setShowHiddenNfts(!showHiddenNfts)}>
                  {showHiddenNfts ? 'Hide' : 'Show'} {portfolio.hiddenNftCollections.length} filtered
                </Button>
              ) : null}
              <Link href="/nfts" className="text-xs text-zinc-500 hover:text-black dark:hover:text-white">
                View collections
              </Link>
            </div>
          }
          bodyClassName="p-0"
        >
          <NftCollectionTable
            collections={showHiddenNfts ? portfolio.nftCollections : portfolio.visibleNftCollections}
            totalValueUsd={portfolio.totals.totalUsd}
          />
        </Card>
      ) : null}
    </div>
  );
};

export default DashboardPage;
