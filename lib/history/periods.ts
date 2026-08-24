import type { SnapshotPoint } from 'lib/hooks/useSnapshots';
import { DAY, WEEK, YEAR } from 'lib/utils/time';

// The periods the headline reports a change over, shortest first.
export const CHANGE_PERIODS = ['1W', '2W', '1M', '3M', '1Y'] as const;
export type ChangePeriod = (typeof CHANGE_PERIODS)[number];

// How much of the history the chart draws. `all` has no duration, which is what makes it "everything".
export const CHART_RANGES = ['all', '1Y', '3M', '1M', '2W', '1W'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export const CHART_RANGE_LABELS: Record<ChartRange, string> = {
  all: 'All',
  '1Y': '1Y',
  '3M': '3M',
  '1M': '1M',
  '2W': '2W',
  '1W': '1W',
};

// A month is taken as 30 days and a year as 365. Calendar months vary, and a portfolio chart gains nothing
// from that precision while losing the property that every period is a fixed distance back from now.
const PERIOD_DURATIONS: Record<ChangePeriod, number> = {
  '1W': WEEK,
  '2W': 2 * WEEK,
  '1M': 30 * DAY,
  '3M': 90 * DAY,
  '1Y': YEAR,
};

const RANGE_DURATIONS: Record<Exclude<ChartRange, 'all'>, number> = {
  '1Y': YEAR,
  '3M': 90 * DAY,
  '1M': 30 * DAY,
  '2W': 2 * WEEK,
  '1W': WEEK,
};

export interface PeriodChange {
  period: ChangePeriod;
  // Null when no snapshot is old enough to compare against, which is not the same as no change.
  changeUsd: number | null;
  changePercentage: number | null;
  // The snapshot the change is measured from. Snapshots are taken whenever the user syncs, so the nearest
  // one on or before the target can be older than the period names; exposing it lets the UI say which
  // moment the figure is really against rather than implying an exactness that is not there.
  baselineTimestamp?: number;
}

// What the portfolio has gained or lost over each period, measured against its value now.
//
// "Now" is the live total rather than the newest snapshot: it is the number displayed above these, and a
// change that did not reconcile with the figure it sits under would be its own kind of wrong.
export const buildPeriodChanges = (
  points: SnapshotPoint[],
  currentTotalUsd: number,
  now: number = Date.now(),
): PeriodChange[] =>
  CHANGE_PERIODS.map((period) => {
    const baseline = findBaseline(points, now - PERIOD_DURATIONS[period]);

    if (!baseline) return { period, changeUsd: null, changePercentage: null };

    const changeUsd = currentTotalUsd - baseline.totalUsd;

    return {
      period,
      changeUsd,
      // A change against nothing is not a percentage. Dividing by zero would render as Infinity.
      changePercentage: baseline.totalUsd > 0 ? (changeUsd / baseline.totalUsd) * 100 : null,
      baselineTimestamp: baseline.timestamp,
    };
  });

// The most recent snapshot at or before a moment. Points are already sorted ascending by timestamp.
const findBaseline = (points: SnapshotPoint[], target: number): SnapshotPoint | undefined => {
  let baseline: SnapshotPoint | undefined;

  for (const point of points) {
    if (point.timestamp > target) break;
    baseline = point;
  }

  return baseline;
};

export const filterPointsByRange = (
  points: SnapshotPoint[],
  range: ChartRange,
  now: number = Date.now(),
): SnapshotPoint[] => {
  if (range === 'all') return points;

  const from = now - RANGE_DURATIONS[range];
  return points.filter((point) => point.timestamp >= from);
};
