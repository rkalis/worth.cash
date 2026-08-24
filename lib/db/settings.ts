import { db } from 'lib/db';
import { setRuntimeSettings } from 'lib/settings/runtime';
import { type AppSettings, mergeSettingsWithDefaults } from 'lib/settings/types';

const SETTINGS_KEY = 'app-settings';

// Settings are stored as a single row rather than one row per field. They are always read and written as a
// whole, and a single row means a settings change is one atomic write rather than a partial update that
// could leave the runtime snapshot describing a state that never existed.
export const loadSettings = async (): Promise<AppSettings> => {
  const stored = await db.settings.get(SETTINGS_KEY);
  const settings = mergeSettingsWithDefaults(stored?.value as Partial<AppSettings> | undefined);
  setRuntimeSettings(settings);
  return settings;
};

export const saveSettings = async (settings: AppSettings): Promise<void> => {
  await db.settings.put({ key: SETTINGS_KEY, value: settings });
  setRuntimeSettings(settings);
};
