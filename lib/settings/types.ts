import type { DisplayCurrency } from 'lib/fiat/rates';

// Every API key the app can use. All of them are optional: the app degrades to whatever data sources
// the currently configured keys allow, rather than failing outright.
export interface ProviderApiKeys {
  // A single Etherscan V2 key covers every Etherscan-family explorer.
  etherscan?: string;
  // Blockscout instances are usually keyless, but hosted ones can be rate limited without a key.
  blockscout?: string;
  coingecko?: string;
  opensea?: string;
  // Envio HyperSync bearer token. Without it HyperSync still works but at a lower rate limit.
  hypersync?: string;
  // Used to build higher-quality RPC URLs for the chains whose configs reference them.
  alchemy?: string;
  drpc?: string;
}

// Which CoinGecko plan the key belongs to. 'auto' probes the API once and caches the result, which is
// what we default to because the free/demo and pro plans use different hostnames and auth headers.
export type CoinGeckoTier = 'auto' | 'public' | 'pro';

export interface SyncSettings {
  // `null` means "every supported chain", which is the default. A list restricts syncing to those chains.
  enabledChainIds: number[] | null;
  includeTestnets: boolean;
  // How many chains are synced concurrently. Higher is faster but more likely to hit provider rate limits.
  chainConcurrency: number;
  // Re-sync a chain at most this often when the app is open.
  refreshIntervalMinutes: number;
  // Skip chains where the address has never sent a transaction and holds no native balance, instead of
  // reading their entire log history to discover nothing. Worth a great deal on a first sync across every
  // chain; see lib/sync/activity.ts for what it can and cannot rule out.
  skipInactiveChains: boolean;
}

export interface SpamSettings {
  // Hide positions whose total value is below this many USD. Tokens without a price are hidden by the
  // `hideUnpricedTokens` flag instead, since their value is unknown rather than small.
  dustThresholdUsd: number;
  hideUnpricedTokens: boolean;
  // Name/symbol heuristics: URLs, "claim"/"reward" bait, unicode lookalikes, broken ERC20 metadata.
  useSpamHeuristics: boolean;
}

export interface DisplaySettings {
  // Prices are always stored in USD. This only decides what they are converted to on the way to the screen,
  // so switching it never touches a stored value. See lib/fiat/rates.ts.
  currency: DisplayCurrency;
  hideBalances: boolean;
}

export interface AppSettings {
  apiKeys: ProviderApiKeys;
  coingeckoTier: CoinGeckoTier;
  rpcOverrides: Record<number, string>;
  sync: SyncSettings;
  spam: SpamSettings;
  display: DisplaySettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeys: {},
  coingeckoTier: 'auto',
  rpcOverrides: {},
  sync: {
    enabledChainIds: null,
    includeTestnets: false,
    chainConcurrency: 4,
    refreshIntervalMinutes: 30,
    skipInactiveChains: true,
  },
  spam: {
    dustThresholdUsd: 1,
    hideUnpricedTokens: true,
    useSpamHeuristics: true,
  },
  display: {
    currency: 'usd',
    hideBalances: false,
  },
};
