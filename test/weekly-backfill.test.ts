import type { StoredSnapshot } from 'lib/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let existingSnapshots = new Map<number, StoredSnapshot>();
const reconstruct = vi.fn();

vi.mock('lib/db', () => ({
  db: { snapshots: { get: async (timestamp: number) => existingSnapshots.get(timestamp) } },
}));

vi.mock('lib/history/reconstruct', () => ({
  reconstructSnapshotAt: (...args: unknown[]) => reconstruct(...args),
}));

const { backfillWeeklySnapshots, weeklyMondayMoments } = await import('lib/history/weekly-backfill');

// Friday 28 Aug 2026, 14:30 UTC.
const NOW = Date.UTC(2026, 7, 28, 14, 30);
const WEEK = 7 * 24 * 60 * 60 * 1000;

const snapshot = (timestamp: number): StoredSnapshot => ({ timestamp, totalUsd: 1, createdAt: 0, positions: [] });

const created = { status: 'created', timestamp: 0, totalUsd: 1 };

beforeEach(() => {
  existingSnapshots = new Map();
  reconstruct.mockReset();
  reconstruct.mockResolvedValue(created);
});

describe('weeklyMondayMoments', () => {
  it('lands every moment on a Monday at nine in the morning UTC', () => {
    const moments = weeklyMondayMoments(NOW - 5 * WEEK, NOW);

    for (const moment of moments) {
      const date = new Date(moment);
      expect(date.getUTCDay()).toBe(1);
      expect(date.getUTCHours()).toBe(9);
      expect(date.getUTCMinutes()).toBe(0);
    }
  });

  it('starts with the most recent Monday and walks backwards', () => {
    const moments = weeklyMondayMoments(NOW - 3 * WEEK, NOW);

    // 28 Aug 2026 is a Friday; the Monday before it is the 24th.
    expect(new Date(moments[0]).toISOString()).toBe('2026-08-24T09:00:00.000Z');
    expect(moments[1] - moments[0]).toBe(-WEEK);
  });

  // Asked on a Monday at 08:00, "the most recent Monday 09:00" is a week ago, not an hour ahead.
  it('never returns a moment in the future', () => {
    const mondayMorning = Date.UTC(2026, 7, 24, 8, 0);
    const moments = weeklyMondayMoments(mondayMorning - 2 * WEEK, mondayMorning);

    expect(moments[0]).toBeLessThan(mondayMorning);
    expect(new Date(moments[0]).toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  // "Back to Wednesday the 12th" includes that week's Monday the 10th: the user asked for history reaching
  // that date, and the week containing it is part of that history.
  it('includes the Monday of the week the target date falls in', () => {
    const wednesday = Date.UTC(2026, 7, 12);
    const moments = weeklyMondayMoments(wednesday, NOW);

    expect(new Date(moments[moments.length - 1]).toISOString()).toBe('2026-08-10T09:00:00.000Z');
  });

  it('returns nothing for a date in the future', () => {
    expect(weeklyMondayMoments(NOW + WEEK, NOW)).toEqual([]);
  });

  // A target of "Sunday the 16th" must include that week's Monday whatever time of day the timestamp
  // carries: noon on the Sunday is the same request as midnight.
  it('ignores the time of day on the target date', () => {
    const sundayMidnight = Date.UTC(2026, 7, 16);
    const sundayNoon = Date.UTC(2026, 7, 16, 12, 0);

    expect(weeklyMondayMoments(sundayNoon, NOW)).toEqual(weeklyMondayMoments(sundayMidnight, NOW));
  });
});

describe('backfillWeeklySnapshots', () => {
  const fourWeeksBack = NOW - 4 * WEEK;

  it('reconstructs the moments newest first, one at a time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await backfillWeeklySnapshots({ untilTimestamp: fourWeeksBack });
    vi.useRealTimers();

    expect(result.status).toBe('completed');
    expect(result.snapshotsCreated).toBe(reconstruct.mock.calls.length);

    const requested = reconstruct.mock.calls.map(([timestamp]) => timestamp as number);
    expect([...requested].sort((a, b) => b - a)).toEqual(requested);
  });

  // The property that makes the run resumable.
  it('leaves weeks that already have a snapshot untouched', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const monday = Date.UTC(2026, 7, 24, 9, 0);
    existingSnapshots.set(monday, snapshot(monday));

    const result = await backfillWeeklySnapshots({ untilTimestamp: fourWeeksBack });
    vi.useRealTimers();

    expect(result.skippedExisting).toBe(1);
    expect(reconstruct.mock.calls.map(([timestamp]) => timestamp)).not.toContain(monday);
  });

  it('stops the whole run at the plan limit, since older weeks can only refuse too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    reconstruct
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce({ status: 'beyond-plan-limit', earliestPricedTimestamp: 12345 });

    const result = await backfillWeeklySnapshots({ untilTimestamp: NOW - 10 * WEEK });
    vi.useRealTimers();

    expect(result.status).toBe('stopped-at-plan-limit');
    expect(result.earliestPricedTimestamp).toBe(12345);
    expect(reconstruct).toHaveBeenCalledTimes(2);
  });

  // A week with nothing held is not a reason to stop: the portfolio can have existed earlier, been sold
  // down to nothing, and been bought back later.
  it('keeps going past a week that held nothing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    reconstruct.mockResolvedValueOnce({ status: 'no-holdings' }).mockResolvedValue(created);

    const result = await backfillWeeklySnapshots({ untilTimestamp: fourWeeksBack });
    vi.useRealTimers();

    expect(result.status).toBe('completed');
    expect(result.momentsWithoutHoldings).toBe(1);
    expect(result.snapshotsCreated).toBe(result.momentsConsidered - 1);
  });

  it('stops between snapshots when cancelled, and reports it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    let calls = 0;
    reconstruct.mockImplementation(async () => {
      calls += 1;
      return created;
    });

    const result = await backfillWeeklySnapshots({
      untilTimestamp: NOW - 10 * WEEK,
      shouldContinue: () => calls < 2,
    });
    vi.useRealTimers();

    expect(result.status).toBe('cancelled');
    expect(reconstruct).toHaveBeenCalledTimes(2);
    expect(result.snapshotsCreated).toBe(2);
    // A cancelled run reports the weeks it actually visited, not the plan it never finished.
    expect(result.momentsConsidered).toBe(2);
  });

  // The slowest step of a reconstruction is fetching exchange history, and it only needs doing once: the
  // ledger is stored, and every later moment replays from it.
  it('fetches exchange history for the first reconstruction only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await backfillWeeklySnapshots({ untilTimestamp: fourWeeksBack, includeExchangeHistory: true });
    vi.useRealTimers();

    const flags = reconstruct.mock.calls.map(
      ([, options]) => (options as { includeExchangeHistory: boolean }).includeExchangeHistory,
    );
    expect(flags[0]).toBe(true);
    expect(flags.slice(1).every((flag) => flag === false)).toBe(true);
  });

  // The card renders "Snapshot N of M" beside the current moment's date, so a between-moments event has
  // to name the moment about to be worked on rather than the one just finished.
  it('points progress at the next moment after finishing one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const events: Array<{ completed: number; timestamp: number }> = [];
    await backfillWeeklySnapshots({
      untilTimestamp: fourWeeksBack,
      onProgress: (progress) => {
        if (!progress.steps)
          events.push({ completed: progress.completedMoments, timestamp: progress.currentTimestamp });
      },
    });
    vi.useRealTimers();

    const monday24 = Date.UTC(2026, 7, 24, 9, 0);
    const monday17 = Date.UTC(2026, 7, 17, 9, 0);
    expect(events[0]).toEqual({ completed: 1, timestamp: monday17 });
    expect(events[0].timestamp).not.toBe(monday24);
  });

  it('reports nothing to do for a future date', async () => {
    const result = await backfillWeeklySnapshots({ untilTimestamp: Date.now() + WEEK });

    expect(result.status).toBe('nothing-to-do');
    expect(reconstruct).not.toHaveBeenCalled();
  });
});
