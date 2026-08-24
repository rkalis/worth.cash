'use client';

import { useCurrency } from 'lib/hooks/useCurrency';
import type { BreakdownEntry } from 'lib/portfolio/breakdown';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

interface Props {
  entries: BreakdownEntry[];
  // What the slices are shares of. Passed in rather than summed from the entries, so a breakdown that folds
  // its tail into a remainder and one that does not both report the same percentages.
  totalUsd: number;
  height?: number;
  emptyMessage?: string;
}

// Slice colours, in the order they are handed out.
//
// Fixed hex rather than theme tokens: these have to stay distinguishable from each other in both light and
// dark, which a palette derived from the page's foreground colour cannot do. The brand colour leads, so the
// largest slice matches the line on the value chart above it.
const SLICE_COLORS = [
  '#fdb952',
  '#3b82f6',
  '#10b981',
  '#a855f7',
  '#ef4444',
  '#06b6d4',
  '#f97316',
  '#84cc16',
  '#ec4899',
  '#6366f1',
  '#14b8a6',
];

// The remainder is deliberately not part of the palette. It is not a place or an asset, it is everything
// left over, and colouring it like one invites reading it as a single holding.
const REMAINDER_COLOR = '#a1a1aa';

// An entry that brought its own colour keeps it. Categories do: a category's colour comes from the user's
// ordering rather than from its rank, so that "stablecoins" does not change colour when it grows.
const sliceColor = (entry: BreakdownEntry, index: number): string =>
  entry.color ?? (entry.isRemainder ? REMAINDER_COLOR : SLICE_COLORS[index % SLICE_COLORS.length]);

// A donut of where the value is, with the figures listed beside it.
//
// The list is not a legend in the recharts sense. A slice worth two percent is unreadable on its own, and
// the question "how much is on Base" is answered by a number rather than by an arc, so the chart shows the
// shape and the list carries the detail.
const ValuePieChart = ({ entries, totalUsd, height = 260, emptyMessage = 'Nothing to show yet.' }: Props) => {
  const { formatValue } = useCurrency();

  if (entries.length === 0 || totalUsd <= 0) {
    return (
      <div className="flex items-center justify-center text-xs text-zinc-500" style={{ height }}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <div className="shrink-0" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={entries}
              dataKey="valueUsd"
              nameKey="label"
              // A donut rather than a full pie: the hole is what stops a chart of two slices reading as a
              // solid disc with a line across it.
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={1}
              stroke="none"
              isAnimationActive={false}
            >
              {entries.map((entry, index) => (
                <Cell key={entry.key} fill={sliceColor(entry, index)} />
              ))}
            </Pie>

            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--color-zinc-300)' }}
              formatter={(value, name) => [formatValue(Number(value)), String(name)]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Capped rather than filling the card. Stacked one above the other on a narrower screen these cards
          run the full width of the page, and a label at one end of that with its figure at the other is two
          columns to read across rather than one line. */}
      <ul className="flex-1 min-w-0 w-full max-w-md flex flex-col gap-1.5">
        {entries.map((entry, index) => (
          <li key={entry.key} className="flex items-baseline gap-2 text-xs">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full shrink-0 self-center"
              style={{ backgroundColor: sliceColor(entry, index) }}
            />
            <span className="truncate text-zinc-700 dark:text-zinc-300" title={entry.label}>
              {entry.label}
            </span>
            <span className="ml-auto tabular shrink-0">{formatValue(entry.valueUsd)}</span>
            <span className="tabular shrink-0 w-12 text-right text-zinc-500">
              {((entry.valueUsd / totalUsd) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default ValuePieChart;
