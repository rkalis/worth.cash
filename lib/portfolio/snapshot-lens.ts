import { db } from 'lib/db';
import type { StoredSnapshot } from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';
import { assemblePortfolio } from 'lib/portfolio/assemble';
import { buildAggregationInputFromSnapshot, type CurrentLens } from 'lib/portfolio/snapshot-input';
import { ASSET_MAP_SETTING_KEY, type StoredAssetMap } from 'lib/prices/assets';

// The present-day lens a snapshot is viewed through, read straight from the tables for callers outside
// React. The hooks read the same tables live; this is for writers that need a total.
export const loadCurrentLens = async (): Promise<CurrentLens> => {
  const [overrides, categoryAssignments, liveTokens, assetMapRow, settings] = await Promise.all([
    db.tokenOverrides.toArray(),
    db.categoryAssignments.toArray(),
    db.tokens.toArray(),
    db.settings.get(ASSET_MAP_SETTING_KEY),
    loadSettings(),
  ]);

  return {
    overrides,
    categoryAssignments,
    spamSettings: settings.spam,
    coinLogoUrls: (assetMapRow?.value as StoredAssetMap | undefined)?.logos,
    liveTokens,
    // Collection icons never reach a total, and every caller of this lens wants only a total, so the
    // collection table is not read just to borrow artwork. The pinned view reads it live for display.
    liveNftCollections: [],
  };
};

// What a snapshot's visible portfolio totals under today's filters.
//
// Every writer that stores or rewrites a snapshot uses this, so the number on the chart is always the
// number the pinned view would show: one aggregation, run at write time.
export const computeSnapshotTotalUsd = async (snapshot: StoredSnapshot): Promise<number> => {
  const lens = await loadCurrentLens();
  return assemblePortfolio(buildAggregationInputFromSnapshot(snapshot, lens)).totals.totalUsd;
};
