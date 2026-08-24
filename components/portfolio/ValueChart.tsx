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
        Not enough history yet. Rebuild it from the History page to fill in past weeks.
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
            // Weekly points are sparse enough that interpolating across a gap would invent a trend.
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ValueChart;
