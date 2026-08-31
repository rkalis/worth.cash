'use client';

import { formatDateShort } from 'lib/format';
import { buildValueAxis } from 'lib/history/axis';
import { useCurrency } from 'lib/hooks/useCurrency';
import type { SnapshotPoint } from 'lib/hooks/useSnapshots';
import { Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Props {
  points: SnapshotPoint[];
  height?: number;
  // Clicking a point hands its timestamp back, which is how a snapshot gets pinned. Absent on charts that
  // are purely a picture.
  onPointClick?: (timestamp: number) => void;
  // The pinned moment, drawn as a solid marker so the chart says which point the page is showing.
  pinnedTimestamp?: number;
}

const ValueChart = ({ points, height = 240, onPointClick, pinnedTimestamp }: Props) => {
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

  const pinnedPoint =
    pinnedTimestamp === undefined ? undefined : points.find((point) => point.timestamp === pinnedTimestamp);

  return (
    <div style={{ height }} className={onPointClick ? 'cursor-pointer' : undefined}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={points}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          // Off because it makes the chart and the hovered dot focusable, which draws the browser's focus
          // ring around them on every click. Keyboard users pin from the History table instead.
          accessibilityLayer={false}
          onClick={(state) => {
            // recharts hands back whichever point the hover cursor was nearest, so a click anywhere on the
            // plot pins the point the tooltip was already naming. On this numeric time axis the active
            // label is the point's timestamp.
            const timestamp = state?.activeLabel;
            if (typeof timestamp === 'number') onPointClick?.(timestamp);
          }}
        >
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

          {pinnedPoint ? (
            <ReferenceDot
              x={pinnedPoint.timestamp}
              y={pinnedPoint.totalUsd}
              r={5}
              fill="var(--color-brand)"
              stroke="var(--color-brand-muted)"
              strokeWidth={2}
            />
          ) : null}

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
