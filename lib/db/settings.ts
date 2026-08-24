import { db } from 'lib/db';
import { setRuntimeSettings } from 'lib/settings/runtime';
import { type AppSettings, DEFAULT_SETTINGS } from 'lib/settings/types';

const SETTINGS_KEY = 'app-settings';

// Settings are stored as a single row rather than one row per field. They are always read and written as a
// whole, and a single row means a settings change is one atomic write rather than a partial update that
// could leave the runtime snapshot describing a state that never existed.
export const loadSettings = async (): Promise<AppSettings> => {
  const stored = await db.settings.get(SETTINGS_KEY);
  const settings = mergeWithDefaults(stored?.value as Partial<AppSettings> | undefined);
  setRuntimeSettings(settings);
  return settings;
};

export const saveSettings = async (settings: AppSettings): Promise<void> => {
  await db.settings.put({ key: SETTINGS_KEY, value: settings });
  setRuntimeSettings(settings);
};

// Merging against the defaults means a settings row written by an older version of the app gains any newly
// added fields instead of leaving them undefined for the rest of the session.
const mergeWithDefaults = (stored: Partial<AppSettings> | undefined): AppSettings => {
  if (!stored) return DEFAULT_SETTINGS;

  return {
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...stored.apiKeys },
    coingeckoTier: stored.coingeckoTier ?? DEFAULT_SETTINGS.coingeckoTier,
    rpcOverrides: { ...DEFAULT_SETTINGS.rpcOverrides, ...stored.rpcOverrides },
    sync: { ...DEFAULT_SETTINGS.sync, ...stored.sync },
    spam: { ...DEFAULT_SETTINGS.spam, ...stored.spam },
    display: { ...DEFAULT_SETTINGS.display, ...stored.display },
  };
};
