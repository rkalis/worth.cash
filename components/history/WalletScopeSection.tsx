'use client';

import Button from 'components/ui/Button';
import InfoTooltip from 'components/ui/InfoTooltip';
import { getChainName } from 'lib/chains';
import { formatDateTimeUtc } from 'lib/format';
import { reprocessWalletScope, type WalletScopeProgress, type WalletScopeResult } from 'lib/history/rescope';
import { useCurrency } from 'lib/hooks/useCurrency';
import { useWalletScopeDrift } from 'lib/hooks/useWalletScopeDrift';
import { useState } from 'react';

const PHASE_LABELS: Record<WalletScopeProgress['phase'], string> = {
  'resolving-blocks': 'Resolving block heights',
  'reading-native-balances': 'Replaying wallets',
  'fetching-prices': 'Fetching historical prices',
  'updating-snapshots': 'Updating snapshots',
};

interface Props {
  // True while the card's other reprocess runs. Both rewrite the same snapshot rows, and racing them means
  // whichever writes last silently discards the other's work.
  disabled: boolean;
  onRunningChange: (isRunning: boolean) => void;
}

// Makes the recorded history measure the wallets tracked today.
const WalletScopeSection = ({ disabled, onRunningChange }: Props) => {
  const drift = useWalletScopeDrift();
  const { formatValue } = useCurrency();

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<WalletScopeProgress>();
  const [result, setResult] = useState<WalletScopeResult>();
  const [error, setError] = useState<string>();
  const [hasPreviewed, setHasPreviewed] = useState(false);
  const [rebuildUnstamped, setRebuildUnstamped] = useState(false);

  const run = async (dryRun: boolean) => {
    setIsRunning(true);
    onRunningChange(true);
    setError(undefined);
    setResult(undefined);
    setProgress(undefined);

    try {
      setResult(await reprocessWalletScope({ dryRun, rebuildUnstamped, onProgress: setProgress }));
      if (dryRun) setHasPreviewed(true);
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
        Tracked wallets
        <InfoTooltip tooltip="Corrects which wallets each point counts. Points recorded since the app began noting who contributed what can have a wallet added or removed exactly; older ones can only be corrected by replaying stored transfer events, which is approximate for rebasing and fee-on-transfer tokens and needs an archive-capable RPC for native balances." />
      </h3>

      {drift.isLoading ? null : <DriftLine drift={drift} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => run(true)}
          loading={isRunning}
          disabled={disabled || isRunning}
        >
          Preview changes
        </Button>

        {/* Only after a preview: this rewrites recorded history, and seeing the before and after first is
            the difference between a decision and a surprise. */}
        <Button
          variant="primary"
          size="sm"
          onClick={() => run(false)}
          disabled={disabled || isRunning || !hasPreviewed}
          title={hasPreviewed ? undefined : 'Preview the changes first'}
        >
          Update snapshots
        </Button>
      </div>

      <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={rebuildUnstamped}
          onChange={(event) => {
            setRebuildUnstamped(event.target.checked);
            setHasPreviewed(false);
          }}
          className="mt-0.5"
        />
        <span className="flex items-center gap-1.5">
          Rebuild every snapshot, even ones that look correctly scoped
          <InfoTooltip tooltip="The only way to correct a wallet you removed before the app started recording which wallets each point measured. Replaces balances read from the chain with balances replayed from stored events." />
        </span>
      </label>

      {progress ? (
        <p className="text-xs text-zinc-500 tabular">
          {PHASE_LABELS[progress.phase]}: {progress.completed} / {progress.total}
        </p>
      ) : null}

      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      {result ? <WalletScopeSummary result={result} formatValue={formatValue} /> : null}
    </div>
  );
};

const DriftLine = ({ drift }: { drift: ReturnType<typeof useWalletScopeDrift> }) => {
  if (drift.snapshotCount === 0) return null;

  if (drift.driftedCount === 0) {
    return (
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        All {drift.snapshotCount} snapshot{drift.snapshotCount === 1 ? '' : 's'} measure the wallets you track today.
      </p>
    );
  }

  return (
    <p className="text-xs text-amber-700 dark:text-amber-500">
      {drift.driftedCount} of {drift.snapshotCount} snapshots measure a different set of wallets.{' '}
      {drift.correctableCount > 0
        ? `${drift.correctableCount} of those can be corrected exactly.`
        : 'None of those can be corrected exactly.'}
    </p>
  );
};

interface SummaryProps {
  result: WalletScopeResult;
  formatValue: (value: number | null | undefined) => string;
}

const WalletScopeSummary = ({ result, formatValue }: SummaryProps) => {
  if (result.status === 'no-snapshots') {
    return (
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        There are no snapshots to check yet. Run a sync to record one, or add a snapshot above for a past moment.
      </p>
    );
  }

  if (result.status === 'no-wallets') {
    return (
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        No wallets are being tracked, so there is nothing to measure the history against. Nothing was changed.
      </p>
    );
  }

  if (result.status === 'in-scope') {
    return (
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Checked {result.snapshotsExamined} snapshot{result.snapshotsExamined === 1 ? '' : 's'}; every one already
        measures the wallets you track today. Nothing was changed.
      </p>
    );
  }

  return (
    <div className="text-xs text-zinc-600 dark:text-zinc-400 flex flex-col gap-1">
      {result.status === 'needs-rebuild' ? (
        <span className="text-amber-700 dark:text-amber-500">
          {result.snapshotsWithUnattributedRemovals} snapshot
          {result.snapshotsWithUnattributedRemovals === 1 ? '' : 's'} still count a wallet you no longer track, and none
          of them record who contributed what, so nothing can be taken out by arithmetic. Only a rebuild can correct
          them.
        </span>
      ) : (
        <span>
          {result.isDryRun ? 'Would correct' : 'Corrected'}{' '}
          {result.snapshotsSubtracted + result.snapshotsFoldedIn + result.snapshotsRebuilt} of{' '}
          {result.snapshotsExamined} snapshots: {result.snapshotsSubtracted} by removing a wallet's recorded share,{' '}
          {result.snapshotsFoldedIn} by replaying a newly tracked wallet, {result.snapshotsRebuilt} rebuilt in full.
        </span>
      )}

      {result.snapshotsWithUnattributedRemovals > 0 && result.status !== 'needs-rebuild' ? (
        <span className="text-amber-700 dark:text-amber-500">
          {result.snapshotsWithUnattributedRemovals} snapshot
          {result.snapshotsWithUnattributedRemovals === 1 ? '' : 's'} still count a wallet you no longer track. They
          were recorded before the app noted who contributed what, so only a rebuild can correct them.
        </span>
      ) : null}

      {result.snapshotsWouldEmpty > 0 ? (
        <span>
          {result.snapshotsWouldEmpty} snapshot{result.snapshotsWouldEmpty === 1 ? ' was' : 's were'} left alone,
          because correcting them would have left a point recording nothing at all.
        </span>
      ) : null}

      {result.unpricedPositionCount > 0 ? (
        <span>
          {result.unpricedPositionCount} holding{result.unpricedPositionCount === 1 ? ' had' : 's had'} no price at the
          moment it was held, and contributed nothing to those totals.
        </span>
      ) : null}

      {result.chainsWithoutArchiveState.length > 0 ? (
        <span className="text-amber-700 dark:text-amber-500">
          These chains could not serve historical state, so native balances are missing from what was replayed:{' '}
          {result.chainsWithoutArchiveState.map((chainId) => getChainName(chainId)).join(', ')}. A custom archive RPC in
          settings fixes this.
        </span>
      ) : null}

      {result.preview.length > 0 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {result.preview.slice(0, 8).map((entry) => (
            <span key={entry.timestamp} className="tabular">
              {formatDateTimeUtc(entry.timestamp)}: {formatValue(entry.totalUsdBefore)} →{' '}
              {formatValue(entry.totalUsdAfter)}
            </span>
          ))}
          {result.preview.length > 8 ? <span>and {result.preview.length - 8} more.</span> : null}
        </div>
      ) : null}
    </div>
  );
};

export default WalletScopeSection;
