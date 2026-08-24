import { DAY, WEEK } from 'lib/utils/time';

// Snapshots are taken weekly on Monday at 09:00 UTC. A fixed weekday and hour means every snapshot is
// directly comparable to the one before it, and that re-running a backfill lands on exactly the same points
// rather than drifting with whenever the sync happened to run.
export const SNAPSHOT_HOUR_UTC = 9;

// 1 = Monday, matching JavaScript's `getUTCDay()` numbering.
const SNAPSHOT_WEEKDAY = 1;

// The most recent Monday 09:00 UTC at or before the given moment.
export const currentSnapshotTimestamp = (now: number = Date.now()): number => {
  const date = new Date(now);
  const startOfDayUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), SNAPSHOT_HOUR_UTC);

  // Sunday is 0, so shifting by 6 makes Monday the start of the week.
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const candidate = startOfDayUtc - daysSinceMonday * DAY;

  // Early on a Monday, before 09:00 UTC, the current week's snapshot has not happened yet.
  return candidate <= now ? candidate : candidate - WEEK;
};

// Every snapshot timestamp in a range, oldest first.
export const getWeeklySnapshotTimestamps = (from: number, to: number = Date.now()): number[] => {
  const latest = currentSnapshotTimestamp(to);

  const timestamps: number[] = [];
  for (let timestamp = latest; timestamp >= from; timestamp -= WEEK) {
    timestamps.push(timestamp);
  }

  return timestamps.reverse();
};

export const isSnapshotWeekday = (timestamp: number): boolean => new Date(timestamp).getUTCDay() === SNAPSHOT_WEEKDAY;
