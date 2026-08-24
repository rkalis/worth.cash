'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import type { StoredSyncCursor } from 'lib/db/schema';
import { summariseTasks, useSyncProgress } from 'lib/sync/progress';
import { useMemo } from 'react';

// Stable identity for the same reason as in useWallets.
const NO_CURSORS: StoredSyncCursor[] = [];

// Combines the in-memory progress of the current run with the durable record of what has been synced, so
// the UI can show both "syncing now" and "last updated" without the caller juggling two sources.
export const useSyncStatus = () => {
  const isRunning = useSyncProgress((state) => state.isRunning);
  const taskMap = useSyncProgress((state) => state.tasks);
  const exchangeStatus = useSyncProgress((state) => state.exchangeStatus);
  const coinIdMapAvailable = useSyncProgress((state) => state.coinIdMapAvailable);

  const cursors = useLiveQuery(() => db.syncCursors.toArray(), [], NO_CURSORS);

  // Derived here rather than inside the store selector: each of these produces a new object, and zustand
  // compares snapshots by reference, so selecting them directly would re-render forever.
  const tasks = useMemo(() => Object.values(taskMap), [taskMap]);
  const summary = useMemo(() => summariseTasks(tasks), [tasks]);

  const lastSyncedAt = cursors.reduce((latest, cursor) => Math.max(latest, cursor.lastSyncedAt), 0);
  const erroredCursors = useMemo(() => cursors.filter((cursor) => cursor.status === 'error'), [cursors]);

  return {
    isRunning,
    tasks,
    summary,
    exchangeStatus,
    coinIdMapAvailable,
    lastSyncedAt: lastSyncedAt || undefined,
    erroredCursors,
  };
};
