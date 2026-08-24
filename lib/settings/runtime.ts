import { type AppSettings, DEFAULT_SETTINGS } from 'lib/settings/types';

// A module-level snapshot of the user's settings.
//
// The chain and event layers need API keys and RPC overrides deep inside synchronous helpers such as
// `Chain.getRpcUrl()`. Threading settings through every one of those call sites would make the ported
// revoke.cash code unrecognisable, so instead we hydrate this snapshot once from IndexedDB when the app
// boots and keep it in sync whenever settings change.
//
// This is intentionally client-only state. Route handlers must never read from it: they are shared
// across requests, so a per-request mutation there would leak one request's credentials into another.
// Route handlers take their credentials as explicit arguments instead.
let currentSettings: AppSettings = DEFAULT_SETTINGS;

export const getRuntimeSettings = (): AppSettings => currentSettings;

export const setRuntimeSettings = (settings: AppSettings): void => {
  currentSettings = settings;
};

export const getApiKey = (provider: keyof AppSettings['apiKeys']): string | undefined => {
  const key = currentSettings.apiKeys[provider];
  return key && key.trim() !== '' ? key.trim() : undefined;
};
