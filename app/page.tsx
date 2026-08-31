'use client';

import PortfolioSections from 'components/portfolio/PortfolioSections';
import PortfolioValue from 'components/portfolio/PortfolioValue';
import SyncBar from 'components/portfolio/SyncBar';
import Spinner from 'components/ui/Spinner';
import { usePinnedPortfolio } from 'lib/hooks/usePinnedPortfolio';
import { usePinnedSnapshot } from 'lib/hooks/usePinnedSnapshot';
import { usePortfolio } from 'lib/hooks/usePortfolio';
import { useSnapshots } from 'lib/hooks/useSnapshots';

const DashboardPage = () => {
  const portfolio = usePortfolio();
  const history = useSnapshots();
  const { snapshot: pinnedSnapshot } = usePinnedSnapshot();
  const pinnedPortfolio = usePinnedPortfolio(pinnedSnapshot);

  if (portfolio.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-zinc-500">
        <Spinner className="size-5" />
      </div>
    );
  }

  // Pinned, everything below the chart is the snapshot's portfolio, assembled through the same
  // aggregation the live one uses. The chart itself stays live so the pin can be moved or released.
  const shownPortfolio = pinnedSnapshot && !pinnedPortfolio.isLoading ? pinnedPortfolio : portfolio;

  return (
    <div className="flex flex-col gap-6">
      <SyncBar />

      <PortfolioValue
        totalUsd={portfolio.totals.totalUsd}
        points={history.points}
        pinnedTotalUsd={pinnedSnapshot ? shownPortfolio.totals.totalUsd : undefined}
      />

      <PortfolioSections key={pinnedSnapshot?.timestamp ?? 'live'} portfolio={shownPortfolio} />
    </div>
  );
};

export default DashboardPage;
