'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import type { StoredSnapshot, StoredWallet } from 'lib/db/schema';
import { diffWallets, normaliseOwners, scopeMatches, scopeMeasuredBy } from 'lib/history/scope';
import { useMemo } from 'react';

export interface WalletScopeDrift {
  snapshotCount: number;
  driftedCount: number;
  // How many of the drifted points can be corrected exactly, by arithmetic on what they already record.
  correctableCount: number;
  // How many still count a wallet that is no longer tracked and cannot be corrected without a rebuild.
  needsRebuildCount: number;
  walletsAdded: number;
  walletsRemoved: number;
  isLoading: boolean;
}

const NO_DRIFT: WalletScopeDrift = {
  snapshotCount: 0,
  driftedCount: 0,
  correctableCount: 0,
  needsRebuildCount: 0,
  walletsAdded: 0,
  walletsRemoved: 0,
  isLoading: true,
};

// Whether the recorded history measures the same wallets the app measures now.
//
// Always on screen rather than behind the button, because the answer is usually "yes" and that is worth
// knowing without pressing anything. It reads two tables and compares in memory, so it costs nothing.
export const useWalletScopeDrift = (): WalletScopeDrift => {
  const snapshots = useLiveQuery(() => db.snapshots.toArray(), []);
  const wallets = useLiveQuery(() => db.wallets.toArray(), []);
  const settingsRow = useLiveQuery(() => db.settings.get('app-settings'), []);

  return useMemo(() => {
    if (!snapshots || !wallets) return NO_DRIFT;

    const sync = (settingsRow?.value as { sync?: { enabledChainIds?: number[] | null; includeTestnets?: boolean } })
      ?.sync;

    const current = {
      wallets: normaliseOwners(wallets.map((wallet: StoredWallet) => wallet.address)),
      chainIds: sync?.enabledChainIds ?? null,
      includeTestnets: sync?.includeTestnets ?? false,
    };

    let driftedCount = 0;
    let correctableCount = 0;
    let needsRebuildCount = 0;
    let walletsAdded = 0;
    let walletsRemoved = 0;

    for (const snapshot of snapshots as StoredSnapshot[]) {
      const measured = scopeMeasuredBy(snapshot, wallets, current);
      if (scopeMatches(measured, current)) continue;

      const { added, removed } = diffWallets(measured.wallets, current.wallets);
      const attributed = new Set(snapshot.attributedOwners ?? []);

      driftedCount += 1;
      walletsAdded = Math.max(walletsAdded, added.length);
      walletsRemoved = Math.max(walletsRemoved, removed.length);

      // Exactly correctable when every removal can be reversed from what the point already records. An
      // addition is always foldable, but it is replayed rather than reversed, so it is not "exact".
      if (removed.every((owner) => attributed.has(owner))) {
        correctableCount += 1;
      } else {
        needsRebuildCount += 1;
      }
    }

    return {
      snapshotCount: snapshots.length,
      driftedCount,
      correctableCount,
      needsRebuildCount,
      walletsAdded,
      walletsRemoved,
      isLoading: false,
    };
  }, [snapshots, wallets, settingsRow]);
};
