'use client';

import AddSnapshotsCard from 'components/history/AddSnapshotsCard';
import ReprocessCard from 'components/history/ReprocessCard';
import ValueChart from 'components/portfolio/ValueChart';
import Card from 'components/ui/Card';
import EmptyState from 'components/ui/EmptyState';
import { formatDateTimeUtc } from 'lib/format';
import { withLivePoint } from 'lib/history/periods';
import { deleteSnapshot } from 'lib/history/snapshot';
import { useCurrency } from 'lib/hooks/useCurrency';
import { usePinnedSnapshotStore } from 'lib/hooks/usePinnedSnapshot';
import { usePortfolio } from 'lib/hooks/usePortfolio';
import { useSnapshots } from 'lib/hooks/useSnapshots';
import { cn } from 'lib/utils/classnames';

const HistoryPage = () => {
  const history = useSnapshots();
  const portfolio = usePortfolio();
  const { formatValue } = useCurrency();
  const pinnedTimestamp = usePinnedSnapshotStore((state) => state.pinnedTimestamp);
  const togglePin = usePinnedSnapshotStore((state) => state.toggle);

  const reversedPoints = [...history.points].reverse();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1>History</h1>
        <p className="text-sm text-zinc-500 mt-1">A snapshot is recorded every time you sync.</p>
      </div>

      <AddSnapshotsCard />

      <ReprocessCard />

      {/* Runs to now, like the chart on the dashboard does. The table below is the record of what was
          actually stored; this is the shape of the value over time, and now is part of that. */}
      <Card title="Portfolio value" bodyClassName="p-2">
        <ValueChart points={withLivePoint(history.points, portfolio.totals.totalUsd)} height={320} />
      </Card>

      <Card title="Snapshots" bodyClassName="p-0">
        {reversedPoints.length === 0 ? (
          <EmptyState
            title="No snapshots yet"
            description="Run a sync to record where your portfolio stands now, or add a snapshot above for a moment in the past."
          />
        ) : (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full min-w-[420px]">
              <thead className="sticky top-0 bg-white dark:bg-black">
                <tr className="text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-left font-medium py-2 pl-4">Taken</th>
                  <th className="text-right font-medium py-2 px-4">Total value</th>
                  <th className="text-right font-medium py-2 px-2">Change</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {reversedPoints.map((point, index) => {
                  const previous = reversedPoints[index + 1];
                  const change = previous ? point.totalUsd - previous.totalUsd : null;

                  return (
                    <tr key={point.timestamp} className="border-b border-zinc-100 dark:border-zinc-900 last:border-0">
                      <td className="py-2 pl-4 text-sm">{formatDateTimeUtc(point.timestamp)}</td>
                      <td className="py-2 px-4 text-right text-sm tabular font-medium">
                        {formatValue(point.totalUsd)}
                      </td>
                      <td
                        className={cn(
                          'py-2 px-2 text-right text-sm tabular',
                          change === null
                            ? 'text-zinc-400'
                            : change >= 0
                              ? 'text-green-600 dark:text-green-500'
                              : 'text-red-600 dark:text-red-500',
                        )}
                      >
                        {change === null ? '-' : `${change >= 0 ? '+' : '-'}${formatValue(Math.abs(change))}`}
                      </td>
                      <td className="py-2 pr-4 pl-2 text-right whitespace-nowrap">
                        {/* The keyboard-reachable way to pin: the chart's click targets are mouse-only,
                            and this table is the same list of points with real buttons. */}
                        <button
                          type="button"
                          aria-pressed={pinnedTimestamp === point.timestamp}
                          aria-label={`${pinnedTimestamp === point.timestamp ? 'Unpin' : 'Pin'} the snapshot from ${formatDateTimeUtc(point.timestamp)}`}
                          title="Show the portfolio as it stood at this snapshot"
                          className={cn(
                            'text-xs px-1',
                            pinnedTimestamp === point.timestamp
                              ? 'text-amber-700 dark:text-amber-500'
                              : 'text-zinc-400 hover:text-black dark:hover:text-white',
                          )}
                          onClick={() => togglePin(point.timestamp)}
                        >
                          {pinnedTimestamp === point.timestamp ? 'pinned' : 'pin'}
                        </button>
                        {/* Snapshots are the user's own records rather than something a schedule produced,
                            so they get to remove one they did not mean to take. */}
                        <button
                          type="button"
                          aria-label={`Delete the snapshot from ${formatDateTimeUtc(point.timestamp)}`}
                          title="Delete this snapshot"
                          className="text-xs text-zinc-400 hover:text-black dark:hover:text-white px-1"
                          onClick={() => deleteSnapshot(point.timestamp)}
                        >
                          delete
                        </button>
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
