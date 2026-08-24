'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { getChainName, SUPPORTED_CHAINS } from 'lib/chains';
import { db } from 'lib/db';
import type { ExchangeKind } from 'lib/db/schema';
import { type LocationIcon, resolveLocationIcon } from 'lib/manual/location-icon';
import { ASSET_MAP_SETTING_KEY, type StoredAssetMap } from 'lib/prices/assets';
import { useMemo } from 'react';

// The chain registry never changes at runtime, so this is built once for the life of the tab rather than
// per render or per location.
const CHAIN_IDS_BY_NAME = new Map(SUPPORTED_CHAINS.map((chainId) => [getChainName(chainId).toLowerCase(), chainId]));

// Resolves what a hand-typed location should be drawn as. See lib/manual/location-icon for the ordering.
export const useLocationIcon = (): ((location: string) => LocationIcon) => {
  const assetMapRow = useLiveQuery(() => db.settings.get(ASSET_MAP_SETTING_KEY), []);
  const accounts = useLiveQuery(() => db.exchangeAccounts.toArray(), []);

  return useMemo(() => {
    const assetMap = assetMapRow?.value as StoredAssetMap | undefined;

    const exchangesByLabel = new Map<string, ExchangeKind>(
      (accounts ?? []).map((account) => [account.label.trim().toLowerCase(), account.exchange]),
    );

    return (location: string) =>
      resolveLocationIcon(location, { chainIdsByName: CHAIN_IDS_BY_NAME, exchangesByLabel, assetMap });
  }, [assetMapRow, accounts]);
};
