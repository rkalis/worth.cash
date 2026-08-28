import { db } from 'lib/db';
import type { ReconstructionStep } from 'lib/history/progress';
import { reconstructSnapshotAt, type SnapshotReconstruction } from 'lib/history/reconstruct';
import { DEFAULT_SNAPSHOT_TIME_UTC } from 'lib/history/snapshot';
import { DAY, WEEK } from 'lib/utils/time';

export interface WeeklyBackfillProgress {
  // Which moment is being reconstructed, and where it sits in the run.
  currentTimestamp: number;
  completedMoments: number;
  totalMoments: number;
  // The current reconstruction's own step list, forwarded so the card can show what the moment is doing.
  steps?: ReconstructionStep[];
}

export interface WeeklyBackfillResult {
  status: 'completed' | 'cancelled' | 'stopped-at-plan-limit' | 'nothing-to-do';
  momentsConsidered: number;
  snapshotsCreated: number;
  // Moments skipped because a snapshot at exactly that timestamp already exists. This is what makes the
  // whole process resumable: run it again after an interruption and it picks up where it stopped.
  skippedExisting: number;
  // Moments where nothing was held, which is the honest answer for weeks before the portfolio existed.
  momentsWithoutHoldings: number;
  // Set when the run stopped because the CoinGecko plan will not price anything older.
  earliestPricedTimestamp?: number;
}

export interface WeeklyBackfillOptions {
  // The oldest date to reach back to, inclusive of that week's Monday.
  untilTimestamp: number;
  // Fetches exchange transaction history before the first reconstruction. Only the first: the ledger is
  // stored once fetched, and re-fetching it for every week would repeat the slowest step dozens of times.
  includeExchangeHistory?: boolean;
  onProgress?: (progress: WeeklyBackfillProgress) => void;
  // Checked between snapshots. Returning false stops the run after the moment in flight, which is what a
  // cancel button needs: a reconstruction is not abandonable midway, but the run is.
  shouldContinue?: () => boolean;
}

// The same hour the add-a-snapshot form defaults to, derived from the same constant so they cannot drift:
// after the daily price feeds have settled, and identical for every point so the points stay comparable.
const SNAPSHOT_HOUR_UTC = Number(DEFAULT_SNAPSHOT_TIME_UTC.split(':')[0]);

// Every Monday 09:00 UTC from the most recent one back to the week containing `until`, newest first.
//
// Newest first is the order the user watches the chart fill in: the recent past is what they remember and
// can sanity-check, and if the run is cancelled halfway the recent half is the half that exists.
export const weeklyMondayMoments = (untilTimestamp: number, now: number = Date.now()): number[] => {
  const current = new Date(now);
  // getUTCDay counts Sunday as 0; this walks back to the most recent Monday.
  const daysSinceMonday = (current.getUTCDay() + 6) % 7;

  let moment = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() - daysSinceMonday,
    SNAPSHOT_HOUR_UTC,
    0,
  );

  // Today can be a Monday before nine, in which case the first candidate is still ahead of us.
  if (moment > now) moment -= WEEK;

  const moments: number[] = [];

  // Inclusive of the week the target date falls in, so asking for "back to March 3rd" produces the Monday
  // of that week even when the 3rd was a Thursday. Measured from the start of the target's UTC day: a
  // time of day on the target must not be able to push its own week out of range.
  const until = new Date(untilTimestamp);
  const startOfTargetDay = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate());
  const oldestMonday = startOfTargetDay - 6 * DAY;

  while (moment >= oldestMonday) {
    moments.push(moment);
    moment -= WEEK;
  }

  return moments;
};

// Adds weekly snapshots one by one, from now back to the requested date.
//
// One by one rather than as a batch, because each point is a full reconstruction with its own progress and
// its own refusals, and a run of fifty is something the user wants to watch and be able to stop. The order
// and the skip rule make it resumable: existing points are never touched, so cancelling and re-running
// continues rather than restarting.
export const backfillWeeklySnapshots = async (options: WeeklyBackfillOptions): Promise<WeeklyBackfillResult> => {
  const moments = weeklyMondayMoments(options.untilTimestamp);

  // Counts the moments actually visited rather than the plan, so a cancelled or plan-limited run does
  // not report weeks it never reached.
  const result: WeeklyBackfillResult = {
    status: 'completed',
    momentsConsidered: 0,
    snapshotsCreated: 0,
    skippedExisting: 0,
    momentsWithoutHoldings: 0,
  };

  if (moments.length === 0) return { ...result, status: 'nothing-to-do' };

  let isFirstReconstruction = true;

  for (const [index, timestamp] of moments.entries()) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { ...result, status: 'cancelled' };
    }

    result.momentsConsidered += 1;

    // A point that already exists is left exactly as it is, whatever wrote it. A sync-recorded point is
    // more accurate than a reconstruction, and a previously reconstructed one is the same answer again.
    if (await db.snapshots.get(timestamp)) {
      result.skippedExisting += 1;
      options.onProgress?.({
        // The next moment, when there is one: this notification is read as "what is happening now", and
        // pairing the finished count with the finished moment's date made the counter look one ahead.
        currentTimestamp: moments[index + 1] ?? timestamp,
        completedMoments: index + 1,
        totalMoments: moments.length,
      });
      continue;
    }

    const reconstruction: SnapshotReconstruction = await reconstructSnapshotAt(timestamp, {
      includeExchangeHistory: options.includeExchangeHistory === true && isFirstReconstruction,
      onProgress: (steps) =>
        options.onProgress?.({
          currentTimestamp: timestamp,
          completedMoments: index,
          totalMoments: moments.length,
          steps,
        }),
    });
    isFirstReconstruction = false;

    if (reconstruction.status === 'created') result.snapshotsCreated += 1;
    if (reconstruction.status === 'no-holdings') result.momentsWithoutHoldings += 1;

    // Everything older is older still, so the refusal that stops this moment stops the run. Continuing
    // would spend a request round per week to be told the same thing.
    if (reconstruction.status === 'beyond-plan-limit') {
      return {
        ...result,
        status: 'stopped-at-plan-limit',
        earliestPricedTimestamp: reconstruction.earliestPricedTimestamp,
      };
    }

    options.onProgress?.({
      currentTimestamp: moments[index + 1] ?? timestamp,
      completedMoments: index + 1,
      totalMoments: moments.length,
    });
  }

  return result;
};
