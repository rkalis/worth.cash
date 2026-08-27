'use client';

import WalletScopeCard from 'components/history/WalletScopeCard';
import SnapshotProgress from 'components/portfolio/SnapshotProgress';
import ValueChart from 'components/portfolio/ValueChart';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import EmptyState from 'components/ui/EmptyState';
import Input from 'components/ui/Input';
import { getChainName } from 'lib/chains';
import { formatDateShort, formatDateTimeUtc } from 'lib/format';
import type { ReconstructionStep } from 'lib/history/progress';
import { reconstructSnapshotAt, type SnapshotReconstruction } from 'lib/history/reconstruct';
import {
  type ManualReprocessProgress,
  type ManualReprocessResult,
  reprocessManualBalances,
} from 'lib/history/reprocess';
import {
  DEFAULT_SNAPSHOT_TIME_UTC,
  deleteSnapshot,
  snapshotTimestampFromUtcInput,
  toUtcDateInputValue,
} from 'lib/history/snapshot';
import { useCurrency } from 'lib/hooks/useCurrency';
import { useSnapshots } from 'lib/hooks/useSnapshots';
import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

const HistoryPage = () => {
  const history = useSnapshots();
  const { formatValue } = useCurrency();

  const [date, setDate] = useState(() => toUtcDateInputValue(Date.now()));
  const [time, setTime] = useState(DEFAULT_SNAPSHOT_TIME_UTC);
  const [includeExchangeHistory, setIncludeExchangeHistory] = useState(false);

  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<ManualReprocessProgress>();
  const [reprocessResult, setReprocessResult] = useState<ManualReprocessResult>();
  const [reprocessError, setReprocessError] = useState<string>();

  const [isBuilding, setIsBuilding] = useState(false);
  const [steps, setSteps] = useState<ReconstructionStep[]>();
  const [result, setResult] = useState<SnapshotReconstruction>();
  const [error, setError] = useState<string>();

  const addSnapshot = async () => {
    setIsBuilding(true);
    setError(undefined);
    setResult(undefined);
    setSteps(undefined);

    try {
      if (requestedTimestamp === null) return;

      setResult(
        await reconstructSnapshotAt(requestedTimestamp, {
          includeExchangeHistory,
          onProgress: setSteps,
        }),
      );
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : String(buildError));
    } finally {
      setIsBuilding(false);
    }
  };

  const reprocessManual = async () => {
    setIsReprocessing(true);
    setReprocessError(undefined);
    setReprocessResult(undefined);
    setReprocessProgress(undefined);

    try {
      setReprocessResult(await reprocessManualBalances(setReprocessProgress));
    } catch (reprocessingError) {
      setReprocessError(reprocessingError instanceof Error ? reprocessingError.message : String(reprocessingError));
    } finally {
      setIsReprocessing(false);
      setReprocessProgress(undefined);
    }
  };

  const requestedTimestamp = snapshotTimestampFromUtcInput(date, time);
  const isValidMoment = requestedTimestamp !== null && requestedTimestamp <= Date.now();
  const reversedPoints = [...history.points].reverse();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1>History</h1>
        <p className="text-sm text-zinc-500 mt-1">
          A snapshot is recorded every time you sync, and you can add one for any past moment from the transfer history
          already stored locally.
        </p>
      </div>

      <Card title="Add a snapshot" bodyClassName="flex flex-col gap-3">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Replays your stored transfer events up to the block current at that moment and prices what was held with
          historical prices. Balances are reconstructed from events rather than read from the chain, so rebasing tokens
          are approximate. Native balances are read from historical chain state, which needs an archive-capable RPC.
          Historical NFT floors need a paid CoinGecko plan; without one, NFTs fall back to today's floor.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Input
              name="snapshot-date"
              label="Date (UTC)"
              type="date"
              value={date}
              max={toUtcDateInputValue(Date.now())}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>

          <div className="w-32">
            <Input
              name="snapshot-time"
              label="Time (UTC)"
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={addSnapshot}
            loading={isBuilding}
            disabled={isBuilding || !isValidMoment}
          >
            Add snapshot
          </Button>
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={includeExchangeHistory}
            onChange={(event) => setIncludeExchangeHistory(event.target.checked)}
            className="size-3.5 accent-brand"
          />
          Fetch exchange transaction history first (slow, and only needed once per exchange account)
        </label>

        {steps ? <SnapshotProgress steps={steps} /> : null}

        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

        {result ? <ReconstructionSummary result={result} formatValue={formatValue} /> : null}
      </Card>

      <WalletScopeCard />

      <Card title="Manual balances in history" bodyClassName="flex flex-col gap-3">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Snapshots taken before you recorded a manual balance know nothing about it. This replays each balance's ledger
          against every snapshot already stored and folds the result into it, pricing what was held at the price of that
          moment. It never adds a snapshot, and it never touches the on-chain or exchange figures in one: those were
          read at the time and are more accurate than anything replayed. Running it again after editing a ledger simply
          brings the same points back up to date.
        </p>

        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={reprocessManual}
            loading={isReprocessing}
            disabled={isReprocessing}
          >
            Update existing snapshots
          </Button>
        </div>

        {reprocessProgress ? (
          <p className="text-xs text-zinc-500 tabular">
            {reprocessProgress.phase === 'fetching-prices' ? 'Fetching historical prices' : 'Updating snapshots'}:{' '}
            {reprocessProgress.completed} / {reprocessProgress.total}
          </p>
        ) : null}

        {reprocessError ? <p className="text-xs text-red-600 dark:text-red-400">{reprocessError}</p> : null}

        {reprocessResult ? <ReprocessSummary result={reprocessResult} /> : null}
      </Card>

      <Card title="Portfolio value" bodyClassName="p-2">
        <ValueChart points={history.points} height={320} />
      </Card>

      <Card title="Snapshots" bodyClassName="p-0">
        {reversedPoints.length === 0 ? (
          <EmptyState
            title="No snapshots yet"
            description="Run a sync to record where your portfolio stands now, or add a snapshot above for a moment in the past."
          />
        ) : (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full min-w-[420px]">
              <thead className="sticky top-0 bg-white dark:bg-black">
                <tr className="text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-left font-medium py-2 pl-4">Taken</th>
                  <th className="text-right font-medium py-2 px-4">Total value</th>
                  <th className="text-right font-medium py-2 px-2">Change</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {reversedPoints.map((point, index) => {
                  const previous = reversedPoints[index + 1];
                  const change = previous ? point.totalUsd - previous.totalUsd : null;

                  return (
                    <tr key={point.timestamp} className="border-b border-zinc-100 dark:border-zinc-900 last:border-0">
                      <td className="py-2 pl-4 text-sm">{formatDateTimeUtc(point.timestamp)}</td>
                      <td className="py-2 px-4 text-right text-sm tabular font-medium">
                        {formatValue(point.totalUsd)}
                      </td>
                      <td
                        className={cn(
                          'py-2 px-2 text-right text-sm tabular',
                          change === null
                            ? 'text-zinc-400'
                            : change >= 0
                              ? 'text-green-600 dark:text-green-500'
                              : 'text-red-600 dark:text-red-500',
                        )}
                      >
                        {change === null ? '-' : `${change >= 0 ? '+' : '-'}${formatValue(Math.abs(change))}`}
                      </td>
                      <td className="py-2 pr-4 pl-2 text-right">
                        {/* Snapshots are now the user's own records rather than something a schedule
                            produced, so they get to remove one they did not mean to take. */}
                        <button
                          type="button"
                          aria-label={`Delete the snapshot from ${formatDateTimeUtc(point.timestamp)}`}
                          title="Delete this snapshot"
                          className="text-xs text-zinc-400 hover:text-black dark:hover:text-white px-1"
                          onClick={() => deleteSnapshot(point.timestamp)}
                        >
                          delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
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

interface SummaryProps {
  result: SnapshotReconstruction;
  formatValue: (value: number | null | undefined) => string;
}

const ReconstructionSummary = ({ result, formatValue }: SummaryProps) => {
  if (result.status === 'beyond-plan-limit') {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-500">
        Your CoinGecko plan only serves prices back to {formatDateShort(result.earliestPricedTimestamp ?? 0)}, so that
        moment cannot be priced and no snapshot was added. A paid plan removes this limit.
      </p>
    );
  }

  if (result.status === 'no-holdings') {
    return (
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Nothing was held at {formatDateTimeUtc(result.timestamp)}, so no snapshot was added. If that looks wrong, the
        transfer events for that period may not be synced yet.
      </p>
    );
  }

  return (
    <div className="text-xs text-zinc-600 dark:text-zinc-400 flex flex-col gap-1">
      <span>
        Added a snapshot for {formatDateTimeUtc(result.timestamp)} worth {formatValue(result.totalUsd)} across{' '}
        {result.positionCount} position{result.positionCount === 1 ? '' : 's'}.
      </span>

      {result.unpricedAssetCount > 0 ? (
        <span>
          {result.unpricedAssetCount} asset{result.unpricedAssetCount === 1 ? '' : 's'} had no historical price and
          contributed nothing to the total.
        </span>
      ) : null}

      {result.nftCollectionsAtCurrentFloor > 0 ? (
        <span>
          {result.nftCollectionsAtCurrentFloor} NFT collection
          {result.nftCollectionsAtCurrentFloor === 1 ? ' was' : 's were'} valued at today's floor price rather than the
          floor at the time, because no historical floor was available for them.
        </span>
      ) : null}

      {result.chainsWithoutNativeHistory.length > 0 ? (
        <span className="text-amber-700 dark:text-amber-500">
          Native balances are missing for {result.chainsWithoutNativeHistory.length} chain
          {result.chainsWithoutNativeHistory.length === 1 ? '' : 's'} (
          {result.chainsWithoutNativeHistory.map((chainId) => getChainName(chainId as never)).join(', ')}), because
          their RPC does not serve historical state. Configuring an archive-capable RPC for those chains in settings
          fixes it.
        </span>
      ) : null}
    </div>
  );
};

export default HistoryPage;
