import { buildPeriodChanges, CHANGE_PERIODS, CHART_RANGES, filterPointsByRange } from 'lib/history/periods';
import { createReconstructionProgress, RECONSTRUCTION_PHASES, type ReconstructionStep } from 'lib/history/progress';
import { DAY, WEEK, YEAR } from 'lib/utils/time';
import { describe, expect, it, vi } from 'vitest';

const NOW = Date.UTC(2026, 7, 24, 12, 0);
const point = (daysAgo: number, totalUsd: number) => ({ timestamp: NOW - daysAgo * DAY, totalUsd });

describe('buildPeriodChanges', () => {
  it('measures every period against the value now', () => {
    const points = [
      point(400, 1000),
      point(200, 2000),
      point(45, 4000),
      point(20, 5000),
      point(10, 8000),
      point(3, 9000),
    ];

    const changes = buildPeriodChanges(points, 10000, NOW);
    const byPeriod = Object.fromEntries(changes.map((change) => [change.period, change.changeUsd]));

    // 1W looks back 7 days: the newest snapshot at or before then is the one from 10 days ago.
    expect(byPeriod['1W']).toBe(2000);
    expect(byPeriod['2W']).toBe(5000);
    expect(byPeriod['1M']).toBe(6000);
    expect(byPeriod['3M']).toBe(8000);
    expect(byPeriod['1Y']).toBe(9000);
  });

  it('reports a percentage against the baseline', () => {
    const changes = buildPeriodChanges([point(10, 8000)], 10000, NOW);
    const oneWeek = changes.find((change) => change.period === '1W');

    expect(oneWeek?.changePercentage).toBeCloseTo(25);
  });

  // A missing baseline is not a change of zero, and drawing it as one would invent a flat period.
  it('reports null where no snapshot goes back far enough', () => {
    const changes = buildPeriodChanges([point(3, 9000)], 10000, NOW);

    expect(changes.every((change) => change.changeUsd === null)).toBe(true);
    expect(changes.every((change) => change.baselineTimestamp === undefined)).toBe(true);
  });

  // Snapshots land whenever the user syncs, so the nearest one on or before the target is often older than
  // the period names. The UI discloses which moment it used, so it has to be reported.
  it('names the snapshot each change is measured from', () => {
    const baseline = point(10, 8000);
    const changes = buildPeriodChanges([baseline], 10000, NOW);

    expect(changes.find((change) => change.period === '1W')?.baselineTimestamp).toBe(baseline.timestamp);
  });

  it('leaves the percentage out when the baseline was worth nothing', () => {
    const changes = buildPeriodChanges([point(10, 0)], 500, NOW);
    const oneWeek = changes.find((change) => change.period === '1W');

    expect(oneWeek?.changeUsd).toBe(500);
    expect(oneWeek?.changePercentage).toBeNull();
  });

  it('reports a loss as a negative change', () => {
    const changes = buildPeriodChanges([point(10, 12000)], 9000, NOW);

    expect(changes.find((change) => change.period === '1W')?.changeUsd).toBe(-3000);
  });

  it('covers every period it advertises', () => {
    expect(buildPeriodChanges([], 0, NOW).map((change) => change.period)).toEqual([...CHANGE_PERIODS]);
  });
});

describe('filterPointsByRange', () => {
  const points = [point(400, 1), point(100, 2), point(20, 3), point(10, 4), point(2, 5)];

  it('returns everything for the all range', () => {
    expect(filterPointsByRange(points, 'all', NOW)).toHaveLength(5);
  });

  it('keeps only points inside the window', () => {
    expect(filterPointsByRange(points, '1W', NOW).map((p) => p.totalUsd)).toEqual([5]);
    expect(filterPointsByRange(points, '2W', NOW).map((p) => p.totalUsd)).toEqual([4, 5]);
    expect(filterPointsByRange(points, '1M', NOW).map((p) => p.totalUsd)).toEqual([3, 4, 5]);
    expect(filterPointsByRange(points, '1Y', NOW).map((p) => p.totalUsd)).toEqual([2, 3, 4, 5]);
  });

  it('includes a point sitting exactly on the boundary', () => {
    const boundary = { timestamp: NOW - WEEK, totalUsd: 7 };
    expect(filterPointsByRange([boundary], '1W', NOW)).toHaveLength(1);
  });

  it('offers a range for every option it advertises', () => {
    for (const range of CHART_RANGES) {
      expect(() => filterPointsByRange(points, range, NOW)).not.toThrow();
    }
  });

  it('does not reach back further than a year for the year range', () => {
    const justOverAYear = { timestamp: NOW - YEAR - DAY, totalUsd: 1 };
    expect(filterPointsByRange([justOverAYear], '1Y', NOW)).toHaveLength(0);
  });
});

describe('createReconstructionProgress', () => {
  const latest = (calls: ReconstructionStep[][]) => calls.at(-1) as ReconstructionStep[];

  it('starts with every step listed as pending', () => {
    const onProgress = vi.fn();
    const progress = createReconstructionProgress(onProgress);

    progress.start('resolving-blocks', 3);
    const steps = latest(onProgress.mock.calls.map(([value]) => value));

    expect(steps.map((step) => step.phase)).toEqual([...RECONSTRUCTION_PHASES]);
    expect(steps.filter((step) => step.status === 'pending')).toHaveLength(RECONSTRUCTION_PHASES.length - 1);
  });

  it('reports progress within a running step', () => {
    const onProgress = vi.fn();
    const progress = createReconstructionProgress(onProgress);

    progress.start('fetching-prices', 40);
    progress.advance('fetching-prices', 12);

    const step = latest(onProgress.mock.calls.map(([value]) => value)).find((s) => s.phase === 'fetching-prices');
    expect(step).toMatchObject({ status: 'running', completed: 12, total: 40 });
  });

  // Finishing suspiciously fast and having had nothing to do look identical in a bare fraction.
  it('marks a step with nothing to do as skipped rather than running', () => {
    const onProgress = vi.fn();
    const progress = createReconstructionProgress(onProgress);

    progress.start('fetching-nft-floors', 0);

    const step = latest(onProgress.mock.calls.map(([value]) => value)).find((s) => s.phase === 'fetching-nft-floors');
    expect(step?.status).toBe('skipped');
  });

  it('completing a step fills in its count', () => {
    const onProgress = vi.fn();
    const progress = createReconstructionProgress(onProgress);

    progress.start('resolving-blocks', 5);
    progress.advance('resolving-blocks', 2);
    progress.complete('resolving-blocks');

    const step = latest(onProgress.mock.calls.map(([value]) => value)).find((s) => s.phase === 'resolving-blocks');
    expect(step).toMatchObject({ status: 'done', completed: 5 });
  });

  // A refused reconstruction stops early, and the steps it never reached must not sit there looking pending
  // forever.
  it('marks everything unfinished as skipped when a run stops early', () => {
    const onProgress = vi.fn();
    const progress = createReconstructionProgress(onProgress);

    progress.start('resolving-blocks', 5);
    progress.skipRemaining();

    const steps = latest(onProgress.mock.calls.map(([value]) => value));
    expect(steps.every((step) => step.status === 'skipped')).toBe(true);
  });

  // React compares by reference; mutating in place would leave the list rendering its first state.
  it('publishes a fresh array each time', () => {
    const onProgress = vi.fn();
    const progress = createReconstructionProgress(onProgress);

    progress.start('resolving-blocks', 2);
    progress.advance('resolving-blocks', 1);

    const [first] = onProgress.mock.calls[0];
    const [second] = onProgress.mock.calls[1];

    expect(first).not.toBe(second);
    expect(first[1]).not.toBe(second[1]);
  });
});
