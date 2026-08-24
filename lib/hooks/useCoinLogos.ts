'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import { ASSET_MAP_SETTING_KEY, type StoredAssetMap } from 'lib/prices/assets';

// A fresh literal each render would make the live query's snapshot a new reference every time, which sends
// useSyncExternalStore into a loop.
const NO_LOGOS: Record<string, string> = {};

// Icons by CoinGecko coin id, from the market data a sync already fetches.
//
// For a manual balance this is the only icon source there is: it has no contract to look up in the whois
// dataset, so the coin id the user chose as its price source is also what gives it a picture.
export const useCoinLogos = (): Record<string, string> => {
  const assetMapRow = useLiveQuery(() => db.settings.get(ASSET_MAP_SETTING_KEY), []);

  return (assetMapRow?.value as StoredAssetMap | undefined)?.logos ?? NO_LOGOS;
};
