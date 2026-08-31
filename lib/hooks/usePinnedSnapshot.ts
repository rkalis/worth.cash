'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import type { StoredSnapshot } from 'lib/db/schema';
import { create } from 'zustand';

interface PinnedSnapshotState {
  pinnedTimestamp?: number;
  pin: (timestamp: number) => void;
  unpin: () => void;
  // Clicking the already-pinned point reads as "let go", so the same gesture toggles.
  toggle: (timestamp: number) => void;
}

// Which snapshot the user has pinned, shared across pages.
//
// A zustand store rather than page state, because the pin is one decision about what the app is showing:
// pinning a point on the portfolio page and then opening the graphs page should show the same moment, not
// silently snap back to live. Deliberately not persisted: a pin is a way of looking, not data, and
// reopening the app in the past would be a trap.
export const usePinnedSnapshotStore = create<PinnedSnapshotState>((set, get) => ({
  pinnedTimestamp: undefined,
  pin: (timestamp) => set({ pinnedTimestamp: timestamp }),
  unpin: () => set({ pinnedTimestamp: undefined }),
  toggle: (timestamp) => set({ pinnedTimestamp: get().pinnedTimestamp === timestamp ? undefined : timestamp }),
}));

export interface PinnedSnapshot {
  snapshot?: StoredSnapshot;
  pinnedTimestamp?: number;
  pin: (timestamp: number) => void;
  unpin: () => void;
  toggle: (timestamp: number) => void;
}

// The pinned snapshot's stored row, live.
//
// Read through a live query so the pin follows the data: if the pinned point is deleted from the History
// page, or rewritten by a reprocess, the view updates rather than showing a row that no longer exists. A
// pin whose snapshot has vanished renders as live, and the timestamp that no longer resolves is cleared
// by the consumer's next toggle rather than by an effect fighting the store.
export const usePinnedSnapshot = (): PinnedSnapshot => {
  const pinnedTimestamp = usePinnedSnapshotStore((state) => state.pinnedTimestamp);
  const pin = usePinnedSnapshotStore((state) => state.pin);
  const unpin = usePinnedSnapshotStore((state) => state.unpin);
  const toggle = usePinnedSnapshotStore((state) => state.toggle);

  const snapshot = useLiveQuery(
    () => (pinnedTimestamp === undefined ? undefined : db.snapshots.get(pinnedTimestamp)),
    [pinnedTimestamp],
  );

  return { snapshot: snapshot ?? undefined, pinnedTimestamp, pin, unpin, toggle };
};
