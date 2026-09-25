'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import type { StoredSnapshot } from 'lib/db/schema';
import { EMPTY_PORTFOLIO, type Portfolio } from 'lib/hooks/usePortfolio';
import { useSettings } from 'lib/hooks/useSettings';
import { assemblePortfolio } from 'lib/portfolio/assemble';
import { buildAggregationInputFromSnapshot } from 'lib/portfolio/snapshot-input';
import { ASSET_MAP_SETTING_KEY, type StoredAssetMap } from 'lib/prices/assets';
import { COIN_FAMILY_MAP_SETTING_KEY, type StoredCoinFamilyMap } from 'lib/prices/coin-families';
import { useMemo } from 'react';

// A pinned snapshot, assembled exactly the way the live portfolio is.
//
// The facts come from the snapshot; the lens is live: overrides, categories, spam settings, logos and icons
// are read through live queries, so hiding a token or refiling a category updates the pinned view the
// same way it updates the present.
export const usePinnedPortfolio = (snapshot: StoredSnapshot | undefined): Portfolio => {
  const overrides = useLiveQuery(() => db.tokenOverrides.toArray(), []);
  const categoryAssignments = useLiveQuery(() => db.categoryAssignments.toArray(), []);
  const liveTokens = useLiveQuery(() => db.tokens.toArray(), []);
  const liveNftCollections = useLiveQuery(() => db.nftCollections.toArray(), []);
  const assetMapRow = useLiveQuery(() => db.settings.get(ASSET_MAP_SETTING_KEY), []);
  const coinFamilyMapRow = useLiveQuery(() => db.settings.get(COIN_FAMILY_MAP_SETTING_KEY), []);
  const { settings } = useSettings();

  return useMemo(() => {
    if (!snapshot || !overrides || !categoryAssignments || !liveTokens || !liveNftCollections) {
      return EMPTY_PORTFOLIO;
    }

    const input = buildAggregationInputFromSnapshot(snapshot, {
      overrides,
      categoryAssignments,
      spamSettings: settings.spam,
      coinLogoUrls: (assetMapRow?.value as StoredAssetMap | undefined)?.logos,
      canonicalCoinIds: (coinFamilyMapRow?.value as StoredCoinFamilyMap | undefined)?.canonicalCoinIds,
      liveTokens,
      liveNftCollections,
    });

    return { ...assemblePortfolio(input), isLoading: false };
  }, [
    snapshot,
    overrides,
    categoryAssignments,
    liveTokens,
    liveNftCollections,
    assetMapRow,
    coinFamilyMapRow,
    settings.spam,
  ]);
};
