'use client';

import { formatDateShort } from 'lib/format';
import { buildValueAxis } from 'lib/history/axis';
import { useCurrency } from 'lib/hooks/useCurrency';
import type { SnapshotPoint } from 'lib/hooks/useSnapshots';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Props {
  points: SnapshotPoint[];
  height?: number;
}

const ValueChart = ({ points, height = 240 }: Props) => {
  const { display, formatValue, formatCompactValue } = useCurrency();

  const axis = buildValueAxis(
    points.map((point) => point.totalUsd),
    display.rate,
  );

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
            // Positioned by when each snapshot was taken, not by how many came before it. Snapshots land
            // whenever you sync, so spacing them evenly draws a month-long gap the same width as an hour
            // and invents a shape the portfolio never had.
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(timestamp) => formatDateShort(timestamp)}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-zinc-400"
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />

          <YAxis
            // Anchored at zero, so the height of the line means what it looks like it means and a 3% week
            // draws as a 3% week. See lib/history/axis.
            domain={axis.domain}
            ticks={axis.ticks}
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

export default ValueChart;
