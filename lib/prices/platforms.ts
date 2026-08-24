import { db } from 'lib/db';
import { coinGeckoRequest } from 'lib/prices/coingecko';
import { WEEK } from 'lib/utils/time';

interface AssetPlatform {
  id: string;
  chain_identifier: number | null;
  name: string;
}

const PLATFORM_MAP_SETTING_KEY = 'coingecko-platform-map';
const PLATFORM_MAP_MAX_AGE = 1 * WEEK;

interface StoredPlatformMap {
  platforms: Record<number, string>;
  updatedAt: number;
}

// CoinGecko uses two different network identifiers, and they are not interchangeable.
//
// Current prices come from the on-chain (GeckoTerminal) API, keyed by network ids like `eth`, which the
// chain config already carries. Historical prices come from the main API, keyed by *asset platform* ids
// like `ethereum`. This resolves the second kind, using the `chain_identifier` field that CoinGecko
// publishes alongside each platform, so it stays correct as they add chains.
export const resolveAssetPlatformId = async (chainId: number): Promise<string | undefined> => {
  const platforms = await getPlatformMap();
  return platforms[chainId];
};

const getPlatformMap = async (): Promise<Record<number, string>> => {
  const stored = (await db.settings.get(PLATFORM_MAP_SETTING_KEY))?.value as StoredPlatformMap | undefined;

  if (stored && Date.now() - stored.updatedAt < PLATFORM_MAP_MAX_AGE) {
    return stored.platforms;
  }

  const platforms = await fetchPlatformMap().catch(() => null);

  if (!platforms) return stored?.platforms ?? {};

  await db.settings.put({ key: PLATFORM_MAP_SETTING_KEY, value: { platforms, updatedAt: Date.now() } });
  return platforms;
};

const fetchPlatformMap = async (): Promise<Record<number, string>> => {
  const platforms = await coinGeckoRequest<AssetPlatform[]>('/asset_platforms');

  const map: Record<number, string> = {};

  for (const platform of platforms) {
    // Non-EVM platforms have no chain identifier, and we have nothing to match them against.
    if (platform.chain_identifier === null || platform.chain_identifier === undefined) continue;
    map[platform.chain_identifier] = platform.id;
  }

  return map;
};
