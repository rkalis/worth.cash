'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import { saveSettings } from 'lib/db/settings';
import { resetCoinGeckoPlan } from 'lib/prices/coingecko';
import { setRuntimeSettings } from 'lib/settings/runtime';
import { type AppSettings, mergeSettingsWithDefaults } from 'lib/settings/types';
import { useCallback, useEffect, useMemo } from 'react';

// Reads settings live and keeps the runtime snapshot in step with them.
//
// The runtime snapshot is what the chain and event layers read synchronously, so it has to be refreshed on
// every change rather than only at startup, or an API key edited in settings would not take effect until a
// page reload.
export const useSettings = () => {
  const storedSettings = useLiveQuery(() => db.settings.get('app-settings'), []);

  // Memoised on the stored row: without this the merged object is a new reference every render, and the
  // effect below would re-run on each one.
  const settings = useMemo(
    () => mergeSettingsWithDefaults(storedSettings?.value as Partial<AppSettings> | undefined),
    [storedSettings],
  );

  useEffect(() => {
    setRuntimeSettings(settings);
  }, [settings]);

  const updateSettings = useCallback(async (update: Partial<AppSettings>) => {
    const current = mergeSettingsWithDefaults(
      (await db.settings.get('app-settings'))?.value as Partial<AppSettings> | undefined,
    );
    const next = { ...current, ...update };

    await saveSettings(next);

    // A changed key may belong to a different CoinGecko plan, so the cached probe result is discarded.
    if (update.apiKeys?.coingecko !== undefined || update.coingeckoTier !== undefined) {
      resetCoinGeckoPlan();
    }
  }, []);

  return { settings, updateSettings, isLoading: storedSettings === undefined };
};
