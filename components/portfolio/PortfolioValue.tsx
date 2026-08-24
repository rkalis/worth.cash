'use client';

import ValueChart from 'components/portfolio/ValueChart';
import { formatDateTimeUtc } from 'lib/format';
import {
  buildPeriodChanges,
  CHART_RANGE_LABELS,
  CHART_RANGES,
  type ChartRange,
  filterPointsByRange,
  type PeriodChange,
} from 'lib/history/periods';
import { useCurrency } from 'lib/hooks/useCurrency';
import type { SnapshotPoint } from 'lib/hooks/useSnapshots';
import { cn } from 'lib/utils/classnames';
import Link from 'next/link';
import { useMemo, useState } from 'react';

interface Props {
  totalUsd: number;
  points: SnapshotPoint[];
}

// The headline figure and the history behind it, in one place.
//
// They were two cards, which meant the number and the line describing how it got there were separated by
// the width of the page. Reading one against the other is the whole point of having both.
const PortfolioValue = ({ totalUsd, points }: Props) => {
  const { formatValue } = useCurrency();
  const [range, setRange] = useState<ChartRange>('all');

  const changes = useMemo(() => buildPeriodChanges(points, totalUsd), [points, totalUsd]);
  const visiblePoints = useMemo(() => filterPointsByRange(points, range), [points, range]);

  const hasChart = points.length >= 2;

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl">
      <div className="flex flex-col md:flex-row">
        <div className={cn('p-5 md:w-64 md:shrink-0', hasChart && 'md:border-r border-zinc-200 dark:border-zinc-800')}>
          <div className="text-xs text-zinc-500 mb-1.5">Total value</div>
          <div className="text-3xl font-semibold tabular tracking-tight">{formatValue(totalUsd)}</div>

          {/* Stacked rather than in a row. Five changes side by side needed the full width of the card,
              which is exactly what moving this beside the chart gives away. */}
          {/* Capped to the width this column has on a wide screen, so the stacked layout does not stretch
              each row across the whole card with the label and the figure at opposite ends. */}
          <div className="flex flex-col gap-1 mt-4 max-w-56">
            {changes.map((change) => (
              <PeriodChangeItem key={change.period} change={change} formatValue={formatValue} />
            ))}
          </div>

          <Link
            href="/history"
            className="inline-block mt-4 text-xs text-zinc-500 hover:text-black dark:hover:text-white"
          >
            View history
          </Link>
        </div>

        {hasChart ? (
          <div className="flex-1 min-w-0 p-3">
            <div className="flex flex-wrap justify-end gap-1 pb-1">
              {CHART_RANGES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={range === option}
                  onClick={() => setRange(option)}
                  className={cn(
                    'px-2 py-1 rounded-md text-xs tabular transition-colors',
                    range === option
                      ? 'bg-zinc-900 text-white dark:bg-white dark:text-black'
                      : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900',
                  )}
                >
                  {CHART_RANGE_LABELS[option]}
                </button>
              ))}
            </div>

            {/* A range holding one point or none cannot draw a line, and an empty chart with a range
                selector above it reads as broken rather than as empty. */}
            {visiblePoints.length >= 2 ? (
              <ValueChart points={visiblePoints} height={200} />
            ) : (
              <div className="flex items-center justify-center h-[200px] text-xs text-zinc-500">
                No snapshots in this range yet.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

interface ChangeProps {
  change: PeriodChange;
  formatValue: (value: number | null | undefined) => string;
}

const PeriodChangeItem = ({ change, formatValue }: ChangeProps) => {
  const { changeUsd, changePercentage, period, baselineTimestamp } = change;

  if (changeUsd === null) {
    return (
      <div className="flex items-baseline justify-between gap-3" title="No snapshot goes back that far yet">
        <span className="text-[11px] text-zinc-400 w-6 shrink-0">{period}</span>
        <span className="text-xs text-zinc-400 tabular">-</span>
      </div>
    );
  }

  const isPositive = changeUsd >= 0;

  return (
    // Snapshots are taken when you sync, so the nearest one on or before the target can be older than the
    // period names. The tooltip says which moment the figure is actually measured from.
    <div
      className="flex items-baseline justify-between gap-3"
      title={baselineTimestamp ? `Since ${formatDateTimeUtc(baselineTimestamp)}` : undefined}
    >
      <span className="text-[11px] text-zinc-400 w-6 shrink-0">{period}</span>
      <span
        className={cn(
          'text-xs tabular truncate',
          isPositive ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-500',
        )}
      >
        {isPositive ? '+' : '-'}
        {formatValue(Math.abs(changeUsd))}
        {changePercentage !== null && Number.isFinite(changePercentage)
          ? ` (${isPositive ? '+' : ''}${changePercentage.toFixed(1)}%)`
          : ''}
      </span>
    </div>
  );
};

export default PortfolioValue;
