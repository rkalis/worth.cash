'use client';

import WalletScopeSection from 'components/history/WalletScopeSection';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import InfoTooltip from 'components/ui/InfoTooltip';
import { formatDateShort } from 'lib/format';
import {
  type ManualReprocessProgress,
  type ManualReprocessResult,
  reprocessManualBalances,
} from 'lib/history/reprocess';
import { useState } from 'react';

// Both ways of folding later knowledge into the snapshots that already exist, in one card: replaying
// manual ledgers, and correcting which wallets a point measures. They share the two prohibitions that
// define reprocessing here, so they share a card; and only one runs at a time, because both rewrite the
// same snapshot rows and racing them means whichever writes last silently discards the other's work.
const ReprocessCard = () => {
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [isRescoping, setIsRescoping] = useState(false);
  const [progress, setProgress] = useState<ManualReprocessProgress>();
  const [result, setResult] = useState<ManualReprocessResult>();
  const [error, setError] = useState<string>();

  const reprocessManual = async () => {
    setIsReprocessing(true);
    setError(undefined);
    setResult(undefined);
    setProgress(undefined);

    try {
      setResult(await reprocessManualBalances(setProgress));
    } catch (reprocessingError) {
      setError(reprocessingError instanceof Error ? reprocessingError.message : String(reprocessingError));
    } finally {
      setIsReprocessing(false);
      setProgress(undefined);
    }
  };

  return (
    <Card
      title={
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          Update existing snapshots
          <InfoTooltip tooltip="Folds later knowledge into the points that already exist. Never adds a snapshot, never removes one, and never touches figures that were read exactly at the time." />
        </h2>
      }
      bodyClassName="flex flex-col gap-4"
    >
      {/* Side by side on a wide screen, matching the add-snapshots card: two independent processes with
          the same prohibitions, read against each other. */}
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6 border-t border-zinc-200 dark:border-zinc-800 pt-4">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            Manual balances
            <InfoTooltip tooltip="Replays each manual balance's ledger into every stored snapshot, valued at that moment. Safe to run again after editing a ledger." />
          </h3>

          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={reprocessManual}
              loading={isReprocessing}
              disabled={isReprocessing || isRescoping}
            >
              Update snapshots
            </Button>
          </div>

          {progress ? (
            <p className="text-xs text-zinc-500 tabular">
              {progress.phase === 'fetching-prices' ? 'Fetching historical prices' : 'Updating snapshots'}:{' '}
              {progress.completed} / {progress.total}
            </p>
          ) : null}

          {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

          {result ? <ReprocessSummary result={result} /> : null}
        </div>

        <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4 lg:border-t-0 lg:pt-0 lg:border-l lg:pl-6">
          <WalletScopeSection disabled={isReprocessing} onRunningChange={setIsRescoping} />
        </div>
      </div>
    </Card>
  );
};

const ReprocessSummary = ({ result }: { result: ManualReprocessResult }) => {
  if (result.status === 'no-snapshots') {
    return (
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        There are no snapshots to update yet. Run a sync to record one, or add a snapshot above for a past moment.
      </p>
    );
  }

  return (
    <div className="text-xs text-zinc-600 dark:text-zinc-400 flex flex-col gap-1">
      <span>
        {result.snapshotsChanged === 0
          ? `Checked ${result.snapshotsExamined} snapshot${result.snapshotsExamined === 1 ? '' : 's'}; every one was already up to date.`
          : `Updated ${result.snapshotsChanged} of ${result.snapshotsExamined} snapshot${
              result.snapshotsExamined === 1 ? '' : 's'
            } with ${result.positionsWritten} manual holding${result.positionsWritten === 1 ? '' : 's'}.`}
      </span>

      {result.unpricedPositionCount > 0 ? (
        <span>
          {result.unpricedPositionCount} holding{result.unpricedPositionCount === 1 ? ' had' : 's had'} no historical
          price at the moment they were held, and contributed nothing to those totals.
        </span>
      ) : null}

      {result.earliestPricedTimestamp ? (
        <span className="text-amber-700 dark:text-amber-500">
          Your CoinGecko plan only serves prices back to {formatDateShort(result.earliestPricedTimestamp)}, so snapshots
          older than that could not be priced. A paid plan removes this limit.
        </span>
      ) : null}
    </div>
  );
};

export default ReprocessCard;
