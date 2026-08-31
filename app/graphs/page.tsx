'use client';

import PortfolioValue from 'components/portfolio/PortfolioValue';
import ValuePieChart from 'components/portfolio/ValuePieChart';
import Card from 'components/ui/Card';
import Spinner from 'components/ui/Spinner';
import { useAssetCategories } from 'lib/hooks/useAssetCategories';
import { usePinnedPortfolio } from 'lib/hooks/usePinnedPortfolio';
import { usePinnedSnapshot } from 'lib/hooks/usePinnedSnapshot';
import { usePortfolio } from 'lib/hooks/usePortfolio';
import { useSnapshots } from 'lib/hooks/useSnapshots';
import { buildAssetBreakdown, buildCategoryBreakdown, buildLocationBreakdown } from 'lib/portfolio/breakdown';
import { useMemo } from 'react';

// How much of the tail to draw before folding it into a remainder. Higher than the summary tiles' ten,
// because a chart has room for slices that a tile has no line for, and lower than everything, because a
// donut of forty slices is a colour wheel rather than a chart.
const MAXIMUM_SLICES = 12;

// Built from the visible positions rather than from every position, so the pies add up to the same total the
// chart above them ends at. Spam and dust are excluded from one for the same reason they are from the other.
//
// Pinned, `shown` is the snapshot's portfolio assembled through the same aggregation as the live one, so
// every pie, the per-chain location pie included, is computed by the same builders whichever moment is
// being looked at.
const GraphsPage = () => {
  const portfolio = usePortfolio();
  const history = useSnapshots();
  const { categories } = useAssetCategories();
  const { snapshot: pinnedSnapshot } = usePinnedSnapshot();
  const pinnedPortfolio = usePinnedPortfolio(pinnedSnapshot);

  const shown = pinnedSnapshot && !pinnedPortfolio.isLoading ? pinnedPortfolio : portfolio;

  const locationBreakdown = useMemo(
    () =>
      buildLocationBreakdown(shown.visibleTokens, shown.visibleNftCollections, {
        maximumEntries: MAXIMUM_SLICES,
      }),
    [shown.visibleTokens, shown.visibleNftCollections],
  );

  const categoryBreakdown = useMemo(
    () => buildCategoryBreakdown(shown.visibleTokens, shown.visibleNftCollections, categories),
    [shown.visibleTokens, shown.visibleNftCollections, categories],
  );

  const assetBreakdown = useMemo(
    () =>
      buildAssetBreakdown(shown.visibleTokens, shown.visibleNftCollections, {
        maximumEntries: MAXIMUM_SLICES,
      }),
    [shown.visibleTokens, shown.visibleNftCollections],
  );

  if (portfolio.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-zinc-500">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1>Graphs</h1>
        <p className="text-sm text-zinc-500 mt-1">
          The same portfolio cut four ways: how it got here, how you have filed it, where it sits, and what it is.
        </p>
      </div>

      <PortfolioValue
        totalUsd={portfolio.totals.totalUsd}
        points={history.points}
        pinnedTotalUsd={pinnedSnapshot ? shown.totals.totalUsd : undefined}
      />

      {/* Side by side on a wide screen, because these answer the same question from different ends and are
          meant to be read against each other. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Value per category">
          <ValuePieChart
            entries={categoryBreakdown}
            totalUsd={shown.totals.totalUsd}
            emptyMessage="Make a category in settings, then file an asset under it from its row in the portfolio table."
          />
        </Card>

        <Card title="Value per location">
          <ValuePieChart
            entries={locationBreakdown}
            totalUsd={shown.totals.totalUsd}
            emptyMessage="No balances to break down yet. Run a sync, or add a manual balance."
          />
        </Card>

        <Card title="Value per asset">
          <ValuePieChart
            entries={assetBreakdown}
            totalUsd={shown.totals.totalUsd}
            emptyMessage="No balances to break down yet. Run a sync, or add a manual balance."
          />
        </Card>
      </div>
    </div>
  );
};

export default GraphsPage;
