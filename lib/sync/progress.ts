import { chainIdSorter } from 'lib/chains';
import { syncCursorKey } from 'lib/db/keys';
import { create } from 'zustand';

export type SyncPhase = 'activity' | 'events' | 'balances' | 'metadata' | 'nfts' | 'floor-prices' | 'prices' | 'done';

export type TaskStatus = 'pending' | 'syncing' | 'done' | 'skipped' | 'error';

export interface ChainSyncTask {
  chainId: number;
  owner: string;
  status: TaskStatus;
  phase?: SyncPhase;
  newEventCount?: number;
  heldTokenCount?: number;
  heldNftCount?: number;
  error?: string;
}

interface SyncProgressState {
  isRunning: boolean;
  startedAt?: number;
  finishedAt?: number;
  // Keyed by chain and owner, so the UI can show one row per wallet per chain.
  tasks: Record<string, ChainSyncTask>;
  exchangeStatus: TaskStatus;
  exchangeError?: string;
  // False when CoinGecko's coin list could not be fetched. Without it no token has an identity, so nothing
  // aggregates across chains and everything shows as a separate row.
  coinIdMapAvailable: boolean;

  beginRun(tasks: Array<{ chainId: number; owner: string }>): void;
  updateTask(chainId: number, owner: string, update: Partial<ChainSyncTask>): void;
  setExchangeStatus(status: TaskStatus, error?: string): void;
  setCoinIdMapAvailable(available: boolean): void;
  finishRun(): void;
  reset(): void;
}

// Progress lives in memory rather than in IndexedDB. It describes the current run only, and persisting it
// would mean an interrupted run leaves permanently stale "syncing" rows behind after a reload. The durable
// record of what has been synced is the cursor table.
export const useSyncProgress = create<SyncProgressState>((set) => ({
  isRunning: false,
  tasks: {},
  exchangeStatus: 'pending',
  coinIdMapAvailable: true,

  beginRun: (tasks) =>
    set({
      isRunning: true,
      startedAt: Date.now(),
      finishedAt: undefined,
      exchangeStatus: 'pending',
      exchangeError: undefined,
      tasks: Object.fromEntries(
        tasks.map((task) => [
          syncCursorKey(task.chainId, task.owner),
          { chainId: task.chainId, owner: task.owner.toLowerCase(), status: 'pending' as const },
        ]),
      ),
    }),

  updateTask: (chainId, owner, update) =>
    set((state) => {
      const key = syncCursorKey(chainId, owner);
      const existing = state.tasks[key] ?? { chainId, owner: owner.toLowerCase(), status: 'pending' as const };

      return { tasks: { ...state.tasks, [key]: { ...existing, ...update } } };
    }),

  setExchangeStatus: (status, error) => set({ exchangeStatus: status, exchangeError: error }),

  setCoinIdMapAvailable: (available) => set({ coinIdMapAvailable: available }),

  finishRun: () => set({ isRunning: false, finishedAt: Date.now() }),

  reset: () =>
    set({ isRunning: false, startedAt: undefined, finishedAt: undefined, tasks: {}, exchangeStatus: 'pending' }),
}));

export interface TaskSummary {
  total: number;
  done: number;
  skipped: number;
  syncing: number;
  errored: number;
}

// A plain function over an already-selected task list rather than a store selector. Used as a selector it
// would build a new object on every call, and zustand compares snapshots by reference, so every render
// would look like a state change and loop.
// Attention order: what needs fixing, then what is happening, then what happened, then what was never
// attempted. A chain that failed is the only row the user can act on, so it must never be buried under
// hundreds of skipped ones.
const TASK_STATUS_RANK: Record<TaskStatus, number> = {
  error: 0,
  syncing: 1,
  pending: 2,
  done: 3,
  skipped: 4,
};

// Sorts by status first, then by the app's usual chain order so rows within a group keep a stable position
// instead of shuffling as the sync progresses.
export const compareTasks = (a: ChainSyncTask, b: ChainSyncTask): number => {
  const byStatus = TASK_STATUS_RANK[a.status] - TASK_STATUS_RANK[b.status];
  if (byStatus !== 0) return byStatus;

  return chainIdSorter(a.chainId, b.chainId);
};

export const summariseTasks = (tasks: ChainSyncTask[]): TaskSummary => ({
  total: tasks.length,
  // Skipped chains count as complete: nothing is outstanding for them.
  done: tasks.filter((task) => task.status === 'done' || task.status === 'skipped').length,
  skipped: tasks.filter((task) => task.status === 'skipped').length,
  syncing: tasks.filter((task) => task.status === 'syncing').length,
  errored: tasks.filter((task) => task.status === 'error').length,
});
