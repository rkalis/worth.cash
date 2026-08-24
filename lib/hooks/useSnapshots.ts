'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import { useMemo } from 'react';

export interface SnapshotPoint {
  timestamp: number;
  totalUsd: number;
}

export interface SnapshotHistory {
  points: SnapshotPoint[];
  latest?: SnapshotPoint;
  previous?: SnapshotPoint;
  changeUsd: number | null;
  changePercentage: number | null;
  isLoading: boolean;
}

// The weekly value history, plus the week-over-week change the dashboard headline shows.
export const useSnapshots = (): SnapshotHistory => {
  const snapshots = useLiveQuery(() => db.snapshots.orderBy('timestamp').toArray(), []);

  return useMemo(() => {
    if (!snapshots) {
      return { points: [], changeUsd: null, changePercentage: null, isLoading: true };
    }

    const points = snapshots.map((snapshot) => ({ timestamp: snapshot.timestamp, totalUsd: snapshot.totalUsd }));
    const latest = points.at(-1);
    const previous = points.at(-2);

    // A change is only meaningful against a non-zero base; dividing by zero would render as Infinity%.
    const changeUsd = latest && previous ? latest.totalUsd - previous.totalUsd : null;
    const changePercentage =
      latest && previous && previous.totalUsd > 0
        ? ((latest.totalUsd - previous.totalUsd) / previous.totalUsd) * 100
        : null;

    return { points, latest, previous, changeUsd, changePercentage, isLoading: false };
  }, [snapshots]);
};
