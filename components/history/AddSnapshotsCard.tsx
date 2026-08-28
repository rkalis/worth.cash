'use client';

import WeeklyBackfillSection from 'components/history/WeeklyBackfillSection';
import SnapshotProgress from 'components/portfolio/SnapshotProgress';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import InfoTooltip from 'components/ui/InfoTooltip';
import Input from 'components/ui/Input';
import { getChainName } from 'lib/chains';
import { formatDateShort, formatDateTimeUtc } from 'lib/format';
import type { ReconstructionStep } from 'lib/history/progress';
import { reconstructSnapshotAt, type SnapshotReconstruction } from 'lib/history/reconstruct';
import { DEFAULT_SNAPSHOT_TIME_UTC, snapshotTimestampFromUtcInput, toUtcDateInputValue } from 'lib/history/snapshot';
import { useCurrency } from 'lib/hooks/useCurrency';
import { useSyncProgress } from 'lib/sync/progress';
import { useState } from 'react';

// Both ways of adding snapshots for the past, in one card: a single chosen moment, and a weekly series
// back to a date. They are the same reconstruction underneath, which is why they share a card, its
// accuracy notes, and the exchange-history switch; and why only one can run at a time, since two
// reconstructions would race each other through the same caches and request queues.
const AddSnapshotsCard = () => {
  const { formatValue } = useCurrency();

  // A reconstruction replays db.transferEvents, and a sync in flight is still writing them: a point built
  // mid-sync counts the chains that have landed and misses the rest, and once stored the backfill's
  // skip-existing rule preserves the undercount forever. Both actions wait the sync out.
  const isSyncing = useSyncProgress((state) => state.isRunning);

  const [date, setDate] = useState(() => toUtcDateInputValue(Date.now()));
  const [time, setTime] = useState(DEFAULT_SNAPSHOT_TIME_UTC);
  const [includeExchangeHistory, setIncludeExchangeHistory] = useState(false);

  const [isBuilding, setIsBuilding] = useState(false);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [steps, setSteps] = useState<ReconstructionStep[]>();
  const [result, setResult] = useState<SnapshotReconstruction>();
  const [error, setError] = useState<string>();

  const requestedTimestamp = snapshotTimestampFromUtcInput(date, time);
  const isValidMoment = requestedTimestamp !== null && requestedTimestamp <= Date.now();

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

  return (
    <Card
      title={
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          Add snapshots
          <InfoTooltip tooltip="Balances are replayed from your stored transfer events and valued with historical prices, so rebasing tokens are approximate. Native balances need an archive-capable RPC, and historical NFT floors need a paid CoinGecko plan; today's floor is used otherwise." />
        </h2>
      }
      bodyClassName="flex flex-col gap-4"
    >
      <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={includeExchangeHistory}
          onChange={(event) => setIncludeExchangeHistory(event.target.checked)}
          disabled={isBuilding || isBackfilling}
          className="size-3.5 accent-brand"
        />
        Fetch exchange history first
        <InfoTooltip tooltip="Slow, and only needed once per exchange account. Without it, reconstructed points cover on-chain and manual holdings only." />
      </label>

      {isSyncing ? (
        <p className="text-xs text-zinc-500">
          Waiting for the running sync to finish, so points are built from a complete event history.
        </p>
      ) : null}

      {/* Side by side on a wide screen: they are alternatives, and reading them next to each other is how
          you pick one. The vertical divider does on large screens what the horizontal one does stacked. */}
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6 border-t border-zinc-200 dark:border-zinc-800 pt-4">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">A single moment</h3>

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
              onClick={addSnapshot}
              loading={isBuilding}
              disabled={isBuilding || isBackfilling || isSyncing || !isValidMoment}
            >
              Add snapshot
            </Button>
          </div>

          {steps ? <SnapshotProgress steps={steps} /> : null}

          {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

          {result ? <ReconstructionSummary result={result} formatValue={formatValue} /> : null}
        </div>

        <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4 lg:border-t-0 lg:pt-0 lg:border-l lg:pl-6">
          <WeeklyBackfillSection
            includeExchangeHistory={includeExchangeHistory}
            disabled={isBuilding || isSyncing}
            onRunningChange={setIsBackfilling}
          />
        </div>
      </div>
    </Card>
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

export default AddSnapshotsCard;
