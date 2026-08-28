'use client';

import SnapshotProgress from 'components/portfolio/SnapshotProgress';
import Button from 'components/ui/Button';
import InfoTooltip from 'components/ui/InfoTooltip';
import Input from 'components/ui/Input';
import { formatDateShort } from 'lib/format';
import { toUtcDateInputValue } from 'lib/history/snapshot';
import {
  backfillWeeklySnapshots,
  type WeeklyBackfillProgress,
  type WeeklyBackfillResult,
  weeklyMondayMoments,
} from 'lib/history/weekly-backfill';
import { useEffect, useRef, useState } from 'react';

interface Props {
  // The card-level checkbox, shared with the single-snapshot form: it means the same thing for both.
  includeExchangeHistory: boolean;
  // True while the card's other action runs. Both actions drive the same reconstruction machinery, and two
  // concurrent reconstructions would race each other through the same caches and queues.
  disabled: boolean;
  onRunningChange: (isRunning: boolean) => void;
}

// Builds a weekly history back to a chosen date, one snapshot at a time.
const WeeklyBackfillSection = ({ includeExchangeHistory, disabled, onRunningChange }: Props) => {
  const [untilDate, setUntilDate] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<WeeklyBackfillProgress>();
  const [result, setResult] = useState<WeeklyBackfillResult>();
  const [error, setError] = useState<string>();

  // A ref rather than state, because the running loop reads it between snapshots and a state value would
  // be frozen inside the closure that started the run. The separate flag exists so the button can show
  // that the request registered: the ref alone causes no re-render.
  const cancelRequested = useRef(false);
  const [isStopping, setIsStopping] = useState(false);

  // Navigating away must not leave the run going invisibly: the loop checks this between snapshots, so
  // unmounting stops it after the moment in flight.
  useEffect(() => {
    return () => {
      cancelRequested.current = true;
    };
  }, []);

  const untilTimestamp = untilDate ? Date.parse(`${untilDate}T00:00:00Z`) : Number.NaN;
  const plannedMoments = Number.isFinite(untilTimestamp) ? weeklyMondayMoments(untilTimestamp) : [];

  const run = async () => {
    if (!Number.isFinite(untilTimestamp)) return;

    cancelRequested.current = false;
    setIsStopping(false);
    setIsRunning(true);
    onRunningChange(true);
    setError(undefined);
    setResult(undefined);
    setProgress(undefined);

    try {
      setResult(
        await backfillWeeklySnapshots({
          untilTimestamp,
          includeExchangeHistory,
          onProgress: setProgress,
          shouldContinue: () => !cancelRequested.current,
        }),
      );
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setIsRunning(false);
      onRunningChange(false);
      setProgress(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium flex items-center gap-1.5">
        Weekly history
        <InfoTooltip tooltip="One snapshot per Monday at 09:00 UTC, newest first, back to the date you pick. Weeks that already have a snapshot at that exact moment are skipped, so cancelling and re-running continues where it stopped." />
      </h3>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Input
            name="backfill-until"
            label="Back to (UTC)"
            type="date"
            value={untilDate}
            max={toUtcDateInputValue(Date.now())}
            onChange={(event) => setUntilDate(event.target.value)}
            disabled={isRunning}
          />
        </div>

        {isRunning ? (
          <Button
            variant="danger"
            disabled={isStopping}
            onClick={() => {
              cancelRequested.current = true;
              setIsStopping(true);
            }}
          >
            {isStopping ? 'Stopping after this snapshot' : 'Stop after this snapshot'}
          </Button>
        ) : (
          // "Backfill N weeks" rather than "add N snapshots": some of those weeks may already have a
          // point and will be skipped, so promising N additions would overstate what the run adds.
          <Button variant="primary" onClick={run} disabled={disabled || plannedMoments.length === 0}>
            {plannedMoments.length > 0
              ? `Backfill ${plannedMoments.length} week${plannedMoments.length === 1 ? '' : 's'}`
              : 'Backfill weekly snapshots'}
          </Button>
        )}
      </div>

      {progress ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-zinc-500 tabular">
            Snapshot {Math.min(progress.completedMoments + 1, progress.totalMoments)} of {progress.totalMoments} ·{' '}
            {formatDateShort(progress.currentTimestamp)}
          </p>
          {progress.steps ? <SnapshotProgress steps={progress.steps} /> : null}
        </div>
      ) : null}

      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      {result ? <BackfillSummary result={result} /> : null}
    </div>
  );
};

const BackfillSummary = ({ result }: { result: WeeklyBackfillResult }) => {
  if (result.status === 'nothing-to-do') {
    return (
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        There are no Mondays between that date and now. Pick an earlier date.
      </p>
    );
  }

  return (
    <div className="text-xs text-zinc-600 dark:text-zinc-400 flex flex-col gap-1">
      <span>
        {result.status === 'cancelled' ? 'Stopped early. ' : ''}
        Added {result.snapshotsCreated} snapshot{result.snapshotsCreated === 1 ? '' : 's'} across{' '}
        {result.momentsConsidered} week{result.momentsConsidered === 1 ? '' : 's'}
        {result.skippedExisting > 0 ? `, leaving ${result.skippedExisting} that already had one` : ''}
        {result.momentsWithoutHoldings > 0
          ? `; ${result.momentsWithoutHoldings} week${result.momentsWithoutHoldings === 1 ? '' : 's'} held nothing and got no point`
          : ''}
        .
      </span>

      {result.status === 'stopped-at-plan-limit' && result.earliestPricedTimestamp ? (
        <span className="text-amber-700 dark:text-amber-500">
          Stopped at {formatDateShort(result.earliestPricedTimestamp)}: your CoinGecko plan serves no prices older than
          that, so earlier weeks cannot be valued. A paid plan removes this limit, and re-running afterwards fills in
          the rest.
        </span>
      ) : null}

      {result.status === 'cancelled' ? (
        <span>Running it again with the same date continues from where it stopped.</span>
      ) : null}
    </div>
  );
};

export default WeeklyBackfillSection;
