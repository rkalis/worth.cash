import { db } from 'lib/db';
import { coinGeckoRequest } from 'lib/prices/coingecko';
import { resolveAssetPlatformId } from 'lib/prices/platforms';
import { DAY } from 'lib/utils/time';
import type { Address } from 'viem';

interface CoinListEntry {
  id: string;
  symbol: string;
  name: string;
  // Asset platform id to contract address, for every chain the coin is deployed on.
  platforms?: Record<string, string | null>;
}

const COIN_ID_MAP_SETTING_KEY = 'coingecko-contract-coin-ids';
const COIN_ID_MAP_MAX_AGE = 1 * DAY;

interface StoredCoinIdMap {
  // Keyed by `${assetPlatformId}:${lowercaseContractAddress}`.
  contracts: Record<string, string>;
  updatedAt: number;
}

// Resolves a contract address to CoinGecko's canonical coin id.
//
// This is the identity the portfolio aggregates on, and it exists because the obvious alternative is
// dangerous. Matching tokens by symbol means anything that calls itself USDC is treated as USDC, and since
// deploying a token named USDC costs nothing, that turns a worthless airdrop into a five-figure line item.
// A coin id cannot be forged: it comes from CoinGecko's own mapping of coin to deployed contract.
//
// It also gets the nuances right for free. Native USDC and bridged USDC.e have different coin ids, so each
// is priced as itself. Grouping them into one row is a separate, later step (see lib/prices/coin-families)
// that never changes what either is worth.
export const resolveCoinIdsForTokens = async (
  chainId: number,
  contractAddresses: Address[],
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  if (contractAddresses.length === 0) return resolved;

  const assetPlatformId = await resolveAssetPlatformId(chainId);
  if (!assetPlatformId) return resolved;

  const contracts = await getContractCoinIdMap();

  for (const address of contractAddresses) {
    const coinId = contracts[`${assetPlatformId}:${address.toLowerCase()}`];
    if (coinId) resolved.set(address.toLowerCase(), coinId);
  }

  return resolved;
};

// Fetches and caches the map up front, before anything else competes for the CoinGecko rate limit.
//
// This matters more than it looks. The map is a single large request, and on a keyless plan a sync issues
// far more price lookups than the per-minute budget allows. Left to be fetched lazily in the middle of that
// storm it gets rate limited, and because every token then resolves to no coin id, cross-chain aggregation
// silently stops working altogether. Returns whether the map ended up usable, so the caller can say so
// rather than leaving the user to wonder why nothing aggregates.
export const primeContractCoinIdMap = async (): Promise<boolean> => {
  const contracts = await getContractCoinIdMap();
  return Object.keys(contracts).length > 0;
};

const getContractCoinIdMap = async (): Promise<Record<string, string>> => {
  const stored = (await db.settings.get(COIN_ID_MAP_SETTING_KEY))?.value as StoredCoinIdMap | undefined;

  if (stored?.contracts && Date.now() - stored.updatedAt < COIN_ID_MAP_MAX_AGE) {
    return stored.contracts;
  }

  const contracts = await fetchContractCoinIdMap().catch(() => null);

  // A failed refresh keeps whatever we had. A coin's contract address does not change, so a stale map is
  // still correct; it just will not know about coins listed since it was built.
  if (!contracts) return stored?.contracts ?? {};

  await db.settings.put({ key: COIN_ID_MAP_SETTING_KEY, value: { contracts, updatedAt: Date.now() } });
  return contracts;
};

// One request returns every coin with its contract address on every chain, which is a few megabytes and
// around 26,000 address mappings. Doing it per token instead would need a request each, and the endpoint
// that answers that is not available on the free plan.
const fetchContractCoinIdMap = async (): Promise<Record<string, string>> => {
  // A few megabytes over a rate-limited connection, so it gets a longer timeout and more patience than a
  // routine price lookup.
  const coins = await coinGeckoRequest<CoinListEntry[]>(
    '/coins/list',
    { include_platform: 'true' },
    { timeout: 120_000, retryLimit: 5 },
  );

  const contracts: Record<string, string> = {};

  for (const coin of coins) {
    for (const [assetPlatformId, address] of Object.entries(coin.platforms ?? {})) {
      if (!address) continue;
      contracts[`${assetPlatformId}:${address.toLowerCase()}`] = coin.id;
    }
  }

  return contracts;
};
