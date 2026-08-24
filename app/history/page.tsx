'use client';

import ValueChart from 'components/portfolio/ValueChart';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import EmptyState from 'components/ui/EmptyState';
import { getChainName } from 'lib/chains';
import { formatDateShort } from 'lib/format';
import { type BackfillProgress, type BackfillResult, backfillWeeklySnapshots } from 'lib/history/backfill';
import { useCurrency } from 'lib/hooks/useCurrency';
import { useSnapshots } from 'lib/hooks/useSnapshots';
import { syncAllExchangeAccounts } from 'lib/sync/exchanges';
import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

const HistoryPage = () => {
  const history = useSnapshots();
  const { formatValue } = useCurrency();
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [progress, setProgress] = useState<BackfillProgress>();
  const [result, setResult] = useState<BackfillResult>();
  const [error, setError] = useState<string>();

  const rebuild = async (includeExchangeLedger: boolean) => {
    setIsRebuilding(true);
    setError(undefined);
    setResult(undefined);

    try {
      // Exchange history is fetched first so that the reconstruction has something to work from. It is the
      // slow part, which is why it is opt-in rather than part of every rebuild.
      if (includeExchangeLedger) {
        await syncAllExchangeAccounts({ includeLedger: true });
      }

      setResult(await backfillWeeklySnapshots(setProgress));
    } catch (rebuildError) {
      setError(rebuildError instanceof Error ? rebuildError.message : String(rebuildError));
    } finally {
      setIsRebuilding(false);
      setProgress(undefined);
    }
  };

  const reversedPoints = [...history.points].reverse();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1>History</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Weekly snapshots, taken every Monday at 09:00 UTC and reconstructed from your transfer history.
        </p>
      </div>

      <Card title="Rebuild history" bodyClassName="flex flex-col gap-3">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Rebuilding replays every stored transfer event against weekly block boundaries and prices each week with
          historical prices. Token balances are reconstructed from events rather than read from chain, so rebasing
          tokens are approximate. Historical NFT floors need a paid CoinGecko plan; without one, NFTs fall back to their
          current floor price.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => rebuild(false)}
            loading={isRebuilding}
            disabled={isRebuilding}
          >
            Rebuild from on-chain history
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => rebuild(true)}
            loading={isRebuilding}
            disabled={isRebuilding}
          >
            Rebuild including exchange history
          </Button>
        </div>

        {progress ? (
          <p className="text-xs text-zinc-500 tabular">
            {progress.phase.replace('-', ' ')}: {progress.completed} / {progress.total}
          </p>
        ) : null}

        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

        {result ? (
          <div className="text-xs text-zinc-600 dark:text-zinc-400 flex flex-col gap-1">
            <span>
              Built {result.snapshotCount} weekly snapshots from {formatDateShort(result.from)} to{' '}
              {formatDateShort(result.to)}.
            </span>
            {result.truncatedByPlan ? (
              <span className="text-amber-700 dark:text-amber-500">
                Your CoinGecko plan only allows 365 days of history, so earlier weeks could not be priced. A paid plan
                removes this limit.
              </span>
            ) : null}
            {result.unpricedAssetCount > 0 ? (
              <span>
                {result.unpricedAssetCount} asset{result.unpricedAssetCount === 1 ? '' : 's'} had no historical price
                and contributed nothing to the chart.
              </span>
            ) : null}
            {result.nftCollectionsAtCurrentFloor > 0 ? (
              <span>
                {result.nftCollectionsAtCurrentFloor} NFT collection
                {result.nftCollectionsAtCurrentFloor === 1 ? ' was' : 's were'} valued at today's floor price rather
                than the floor at the time, because no historical floor was available for them.
              </span>
            ) : null}
            {result.chainsWithoutNativeHistory.length > 0 ? (
              <span className="text-amber-700 dark:text-amber-500">
                Native balance history is missing for {result.chainsWithoutNativeHistory.length} chain
                {result.chainsWithoutNativeHistory.length === 1 ? '' : 's'} (
                {result.chainsWithoutNativeHistory.map((chainId) => getChainName(chainId as never)).join(', ')}
                ), because their RPC does not serve historical state. Configuring an archive-capable RPC for those
                chains in settings fixes it.
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card title="Portfolio value" bodyClassName="p-2">
        <ValueChart points={history.points} height={320} />
      </Card>

      <Card title="Snapshots" bodyClassName="p-0">
        {reversedPoints.length === 0 ? (
          <EmptyState
            title="No snapshots yet"
            description="Rebuild your history above to reconstruct past weeks from the transfer events already stored locally."
          />
        ) : (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-white dark:bg-black">
                <tr className="text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-left font-medium py-2 pl-4">Week</th>
                  <th className="text-right font-medium py-2 px-4">Total value</th>
                  <th className="text-right font-medium py-2 pr-4">Change</th>
                </tr>
              </thead>
              <tbody>
                {reversedPoints.map((point, index) => {
                  const previous = reversedPoints[index + 1];
                  const change = previous ? point.totalUsd - previous.totalUsd : null;

                  return (
                    <tr key={point.timestamp} className="border-b border-zinc-100 dark:border-zinc-900 last:border-0">
                      <td className="py-2 pl-4 text-sm">{formatDateShort(point.timestamp)}</td>
                      <td className="py-2 px-4 text-right text-sm tabular font-medium">
                        {formatValue(point.totalUsd)}
                      </td>
                      <td
                        className={cn(
                          'py-2 pr-4 text-right text-sm tabular',
                          change === null
                            ? 'text-zinc-400'
                            : change >= 0
                              ? 'text-green-600 dark:text-green-500'
                              : 'text-red-600 dark:text-red-500',
                        )}
                      >
                        {change === null ? '-' : `${change >= 0 ? '+' : '-'}${formatValue(Math.abs(change))}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default HistoryPage;
