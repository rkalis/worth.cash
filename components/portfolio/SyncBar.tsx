'use client';

import Badge from 'components/ui/Badge';
import Button from 'components/ui/Button';
import ChainLogo from 'components/ui/ChainLogo';
import { getChainName } from 'lib/chains';
import { formatRelativeTime, shortenAddress } from 'lib/format';
import { useExchangeAccounts } from 'lib/hooks/useExchangeAccounts';
import { useManualBalances } from 'lib/hooks/useManualBalances';
import { useSyncStatus } from 'lib/hooks/useSyncStatus';
import { useWallets } from 'lib/hooks/useWallets';
import { runSync } from 'lib/sync/engine';
import { compareTasks } from 'lib/sync/progress';
import Link from 'next/link';
import { useState } from 'react';

const SyncBar = () => {
  const { isRunning, tasks, summary, lastSyncedAt, exchangeStatus, coinIdMapAvailable } = useSyncStatus();
  const { wallets } = useWallets();
  const { accounts } = useExchangeAccounts();
  const { balances: manualBalances } = useManualBalances();
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string>();

  const enabledWallets = wallets.filter((wallet) => wallet.enabled === 1);

  // A wallet is not the only thing worth syncing. An exchange account or a manual balance still needs
  // prices fetched and a point recorded, so the "add a wallet" prompt is only right when there is genuinely
  // nothing configured at all.
  const hasSomethingToSync = enabledWallets.length > 0 || accounts.length > 0 || manualBalances.length > 0;
  const activeTasks = tasks.filter((task) => task.status === 'syncing');
  const failedTasks = tasks.filter((task) => task.status === 'error');

  const startSync = async () => {
    setError(undefined);
    try {
      await runSync();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    }
  };

  if (!hasSomethingToSync) {
    return (
      <div className="flex items-center justify-between gap-4 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Nothing tracked yet. Add a wallet address, an exchange account, or a manual balance to start building your
          portfolio.
        </p>
        <Link href="/settings">
          <Button variant="primary" size="sm">
            Add a wallet
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="primary" size="sm" onClick={startSync} loading={isRunning} disabled={isRunning}>
            {isRunning ? 'Syncing' : 'Sync now'}
          </Button>

          <div className="text-xs text-zinc-500 truncate">
            {isRunning ? (
              <span>
                {summary.done} of {summary.total} chain syncs complete
                {activeTasks.length > 0 ? ` · ${activeTasks.length} in flight` : ''}
              </span>
            ) : lastSyncedAt ? (
              <span>Last synced {formatRelativeTime(lastSyncedAt)}</span>
            ) : (
              <span>Never synced</span>
            )}
          </div>

          {summary.skipped > 0 ? <Badge>{summary.skipped} skipped</Badge> : null}
          {failedTasks.length > 0 ? <Badge variant="danger">{failedTasks.length} failed</Badge> : null}
          {exchangeStatus === 'error' ? <Badge variant="danger">Exchanges failed</Badge> : null}
        </div>

        {tasks.length > 0 ? (
          <Button variant="tertiary" size="sm" onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? 'Hide detail' : 'Show detail'}
          </Button>
        ) : null}
      </div>

      {isRunning ? (
        <div className="h-0.5 bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
          <div
            className="h-full bg-brand transition-[width] duration-300 ease-expo-out"
            style={{ width: `${summary.total === 0 ? 0 : (summary.done / summary.total) * 100}%` }}
          />
        </div>
      ) : null}

      {error ? <p className="px-4 pb-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      {/* Without the coin list nothing has an identity, so the same asset shows once per chain. Saying so is
          better than leaving the user to wonder why their USDC stopped adding up. */}
      {!coinIdMapAvailable ? (
        <p className="px-4 pb-3 text-xs text-amber-700 dark:text-amber-500">
          CoinGecko's coin list could not be fetched, usually a rate limit on the free tier. Tokens are shown per chain
          instead of combined until the next sync succeeds.
        </p>
      ) : null}

      {isExpanded ? (
        <div className="border-t border-zinc-200 dark:border-zinc-800 max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {[...tasks].sort(compareTasks).map((task) => (
                <tr
                  key={`${task.chainId}:${task.owner}`}
                  className="border-b border-zinc-100 dark:border-zinc-900 last:border-0"
                >
                  <td className="px-4 py-1.5 w-6">
                    <ChainLogo chainId={task.chainId} size={14} />
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap font-medium">{getChainName(task.chainId as never)}</td>
                  <td className="py-1.5 pr-3 font-mono text-zinc-500 hidden sm:table-cell">
                    {shortenAddress(task.owner)}
                  </td>
                  <td className="py-1.5">
                    {task.status === 'error' ? (
                      <span className="text-red-600 dark:text-red-400">{task.error}</span>
                    ) : task.status === 'skipped' ? (
                      <span className="text-zinc-400">no account activity, skipped</span>
                    ) : task.status === 'syncing' ? (
                      <span className="text-zinc-500">{task.phase}</span>
                    ) : task.status === 'done' ? (
                      <span className="text-zinc-400">
                        {task.heldTokenCount ?? 0} tokens
                        {task.heldNftCount ? `, ${task.heldNftCount} NFTs` : ''}
                      </span>
                    ) : (
                      <span className="text-zinc-400">pending</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
};

export default SyncBar;
