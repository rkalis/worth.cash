'use client';

import { formatDateShort } from 'lib/format';
import { useCurrency } from 'lib/hooks/useCurrency';
import type { SnapshotPoint } from 'lib/hooks/useSnapshots';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Props {
  points: SnapshotPoint[];
  height?: number;
}

const ValueChart = ({ points, height = 240 }: Props) => {
  const { formatValue, formatCompactValue } = useCurrency();

  if (points.length < 2) {
    return (
      <div className="flex items-center justify-center text-xs text-zinc-500" style={{ height }}>
        Not enough history yet. Sync to record a point, or add one for a past date from the History page.
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="value-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-brand)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-brand)" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid
            strokeDasharray="3 3"
            stroke="currentColor"
            className="text-zinc-200 dark:text-zinc-800"
            vertical={false}
          />

          <XAxis
            dataKey="timestamp"
            tickFormatter={(timestamp) => formatDateShort(timestamp)}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-zinc-400"
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />

          <YAxis
            // Fitted to the values in view rather than anchored at zero. Over a short range a portfolio
            // moves by a few percent, and a zero-based axis flattens that into a straight line at the top
            // of the chart, which is exactly the shape someone picking "1W" is trying to see. The absolute
            // figure is never in doubt: it is the headline above the chart.
            domain={verticalDomain(points)}
            tickFormatter={(value) => formatCompactValue(value)}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-zinc-400"
            tickLine={false}
            axisLine={false}
            width={56}
          />

          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--color-zinc-300)' }}
            labelFormatter={(timestamp) => formatDateShort(Number(timestamp))}
            formatter={(value) => [formatValue(Number(value)), 'Total value']}
          />

          <Area
            type="monotone"
            dataKey="totalUsd"
            stroke="var(--color-brand)"
            strokeWidth={2}
            fill="url(#value-gradient)"
            dot={false}
            // Points are sparse and unevenly spaced, so interpolating across a gap would invent a trend.
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

// Room above and below the line so it is not drawn against the edges of the plot.
//
// A flat history has no range to pad, so it falls back to a margin around the value itself; padding zero
// would collapse the domain to a single number and recharts would have nothing to scale against.
const verticalDomain = (points: SnapshotPoint[]): [number, number] => {
  const values = points.map((point) => point.totalUsd);
  const lowest = Math.min(...values);
  const highest = Math.max(...values);

  const padding = highest > lowest ? (highest - lowest) * 0.15 : Math.max(highest * 0.05, 1);

  // Never below zero: a portfolio cannot be worth less than nothing, and axis labels saying otherwise
  // would be nonsense.
  return [Math.max(0, lowest - padding), highest + padding];
};

export default ValueChart;
