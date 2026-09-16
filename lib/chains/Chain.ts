import { ChainId } from 'lib/chains/ids';
import { getApiKey, getRuntimeSettings } from 'lib/settings/runtime';
import type { EtherscanPlatform, RateLimit } from 'lib/types';
import { deduplicateArray, isNullish } from 'lib/utils';
import { SECOND } from 'lib/utils/time';
import {
  type ChainContract,
  createPublicClient,
  defineChain,
  fallback,
  http,
  type PublicClient,
  type Chain as ViemChain,
} from 'viem';
import { chainConfig as opStackChainConfig } from 'viem/op-stack';

export interface ChainOptions {
  type: SupportType;
  chainId: number;
  name: string;
  logoUrl: string;
  infoUrl: string;
  nativeCurrency: NativeCurrency;
  nativeTokenCoingeckoId?: string;
  coingeckoNetworkId?: string;
  explorerUrl: string;
  etherscanCompatibleApiUrl?: string;
  rpc: {
    main: string;
    logs?: string;
    traces?: string;
    free?: string;
  };
  deployedContracts?: DeployedContracts;
  isTestnet?: boolean;
  isCanary?: boolean;
  isOpStack?: boolean;
  correspondingMainnetChainId?: number;
}

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export type DeployedContracts = Record<string, ChainContract>;

export enum SupportType {
  // A chain we can query through a plain RPC node, which is the highest quality source when available.
  PROVIDER = 'PROVIDER',
  HYPERSYNC = 'HYPERSYNC',
  ETHERSCAN = 'ETHERSCAN',
  BLOCKSCOUT = 'BLOCKSCOUT', // Mostly Etherscan compatible, with slight differences in the API
  ROUTESCAN = 'ROUTESCAN', // Fully Etherscan compatible, separate only for identification
  UNSUPPORTED = 'UNSUPPORTED',
}

// RPC URLs in the chain list embed these placeholders rather than a baked-in key, because our keys come
// from the user's settings at runtime rather than from the environment at module load.
const RPC_PLACEHOLDERS = {
  '{ALCHEMY_API_KEY}': () => getApiKey('alchemy'),
  '{DRPC_API_KEY}': () => getApiKey('drpc'),
} as const;

// Enough to ride out a few dead hosts without turning one failed call into a long serial retry chain.
const MAX_FALLBACK_RPC_URLS = 5;

// A URL that still carries a placeholder or template, such as `{DRPC_API_KEY}` with no key configured or a
// `${...}` copied from documentation, produces a request to a literal `{...}` path. That fails in a way that
// reads as the chain being unreachable rather than as a missing key, so such a URL is never handed out.
const hasUnresolvedTemplate = (url: string): boolean => url.includes('{') || url.toUpperCase().includes('%7B');

// We only ever build HTTP clients, and handing a WebSocket URL to an HTTP transport produces a failure that
// reads as the endpoint being down.
const isHttpUrl = (url: string): boolean => url.startsWith('https://') || url.startsWith('http://');

const isUsableRpcUrl = (url: string): boolean => isHttpUrl(url) && !hasUnresolvedTemplate(url);

const resolveRpcPlaceholders = (url: string): string | undefined => {
  const placeholders = Object.entries(RPC_PLACEHOLDERS).filter(([placeholder]) => url.includes(placeholder));
  if (placeholders.length === 0) return url;

  return placeholders.reduce<string | undefined>((resolvedUrl, [placeholder, getKey]) => {
    if (isNullish(resolvedUrl)) return undefined;
    const key = getKey();
    // Without the key this URL is unusable, so we drop it and fall through to the next candidate RPC.
    if (!key) return undefined;
    return resolvedUrl.replaceAll(placeholder, key);
  }, url);
};

export class Chain {
  chainId: number;
  type: SupportType;

  constructor(private options: ChainOptions) {
    this.chainId = options.chainId;
    this.type = options.type;
  }

  isSupported(): boolean {
    return this.type !== SupportType.UNSUPPORTED;
  }

  getName(): string {
    if (!this.isSupported()) {
      return `${this.options.name} (Unsupported)`;
    }

    return this.options.name;
  }

  getSlug(): string {
    const chainName = this.getName();
    return chainName
      .toLowerCase()
      .replace(' (unsupported)', '')
      .replace(/\s/g, '-')
      .replace(/\./g, '-')
      .replace(/zerθ/g, 'zero');
  }

  isTestnet(): boolean {
    return this.options.isTestnet ?? false;
  }

  isCanary(): boolean {
    return this.options.isCanary ?? false;
  }

  isOpStack(): boolean {
    return this.options.isOpStack ?? false;
  }

  getLogoUrl(): string {
    return this.options.logoUrl;
  }

  getExplorerUrl(): string {
    return this.options.explorerUrl;
  }

  getFreeRpcUrl(): string {
    return this.options.rpc.free ?? this.getRpcUrl();
  }

  // Every usable endpoint for the chain, most preferred first: the user's own RPC, then the chain's main RPC
  // (usually a keyed provider), then its keyless public RPC. The public one is what keeps a chain reachable
  // for someone who has configured no provider key, since the keyed URL is dropped when its key is missing.
  getRpcUrls(): string[] {
    const userOverride = getRuntimeSettings().rpcOverrides[this.chainId];

    // Unusable entries are dropped rather than ranked last, since a request to one fails in a way that looks
    // like the chain being down rather than like a bad URL.
    const rpcUrls = [userOverride, this.options.rpc.main, this.options.rpc.free]
      .filter((url): url is string => !isNullish(url))
      .map((url) => resolveRpcPlaceholders(url))
      .filter((url): url is string => !isNullish(url) && isUsableRpcUrl(url));

    // A user-configured RPC always wins: it is the only one we know has the rate limits they paid for. It is
    // often the same URL as one of the configured ones, and trying the same host twice in a row is no failover.
    return deduplicateArray(rpcUrls);
  }

  getRpcUrl(): string {
    return this.getRpcUrls()[0];
  }

  getLogsRpcUrl(): string {
    return this.getLogsRpcUrls()[0];
  }

  // The chain's dedicated logs endpoint, where it has one, followed by its ordinary endpoints as backups.
  // Returning the whole list rather than just the preferred one is what lets the client fail over.
  getLogsRpcUrls(): string[] {
    const configuredLogsRpc = this.options.rpc.logs ? resolveRpcPlaceholders(this.options.rpc.logs) : undefined;
    const rpcUrls = this.getRpcUrls();

    if (!configuredLogsRpc || !isUsableRpcUrl(configuredLogsRpc)) return rpcUrls;
    return [configuredLogsRpc, ...rpcUrls.filter((url) => url !== configuredLogsRpc)];
  }

  getInfoUrl(): string {
    return this.options.infoUrl;
  }

  getNativeToken(): string {
    return this.options.nativeCurrency.symbol;
  }

  getNativeTokenDecimals(): number {
    return this.options.nativeCurrency.decimals;
  }

  getNativeTokenCoingeckoId(): string | undefined {
    return this.options.nativeTokenCoingeckoId ?? (this.getNativeToken() === 'ETH' ? 'ethereum' : undefined);
  }

  // The CoinGecko on-chain (GeckoTerminal) network identifier, used to price tokens by contract address.
  getCoingeckoNetworkId(): string | undefined {
    return this.options.coingeckoNetworkId;
  }

  getEtherscanCompatibleApiUrl(): string | undefined {
    if (this.type === SupportType.ROUTESCAN) {
      return `https://api.routescan.io/v2/network/${this.isTestnet() ? 'testnet' : 'mainnet'}/evm/${this.chainId}/etherscan/api`;
    }

    if (this.type === SupportType.BLOCKSCOUT && isNullish(this.options.etherscanCompatibleApiUrl)) {
      return `https://api.blockscout.com/${this.chainId}/api`;
    }

    return this.options.etherscanCompatibleApiUrl ?? 'https://api.etherscan.io/v2/api';
  }

  // The Blockscout v2 REST API, which is a different surface from the Etherscan-compatible v1 API and is
  // the only one that exposes ready-made token balances. Only defined for Blockscout-backed chains.
  getBlockscoutV2ApiUrl(): string | undefined {
    if (this.type !== SupportType.BLOCKSCOUT) return undefined;

    const apiUrl = this.getEtherscanCompatibleApiUrl();
    if (!apiUrl) return undefined;

    if (apiUrl.startsWith('https://api.blockscout.com/')) {
      return `https://api.blockscout.com/${this.chainId}/api/v2`;
    }

    // Self-hosted Blockscout instances expose v2 alongside the legacy API at `/api` -> `/api/v2`.
    return apiUrl.replace(/\/api\/?$/, '/api/v2');
  }

  getEtherscanCompatibleApiKey(): string | undefined {
    // Blockscout instances are keyless, and passing an Etherscan key to them is at best ignored.
    if (this.type === SupportType.BLOCKSCOUT) return getApiKey('blockscout');
    return getApiKey('etherscan');
  }

  getEtherscanCompatibleApiRateLimit(): RateLimit {
    // Etherscan's free tier allows 5 requests per second, which we underestimate as 4/s to stay safe.
    // Without an API key it drops to 1 per 5 seconds, which is too slow to sync with, so we assume a key.
    if (!this.getEtherscanCompatibleApiKey() && this.type !== SupportType.BLOCKSCOUT) {
      return { interval: 5 * SECOND, intervalCap: 1 };
    }

    return { interval: SECOND, intervalCap: 4 };
  }

  getEtherscanCompatibleApiIdentifier(): string {
    const platform = this.getEtherscanCompatiblePlatformNames();
    const apiKey = this.getEtherscanCompatibleApiKey();
    return `${platform?.domain}:${apiKey}`;
  }

  getEtherscanCompatiblePlatformNames = (): EtherscanPlatform | undefined => {
    const apiUrl = this.getEtherscanCompatibleApiUrl();
    if (!apiUrl) return undefined;

    const domain = new URL(apiUrl).hostname.split('.').at(-2)!;
    const subdomain = new URL(apiUrl).hostname.split('.').at(-3)?.split('-').at(-1);
    return { domain, subdomain };
  };

  getCorrespondingMainnetChainId(): number | undefined {
    return this.options.correspondingMainnetChainId;
  }

  getDeployedContracts(): DeployedContracts | undefined {
    return this.options.deployedContracts;
  }

  getViemChainConfig(): ViemChain {
    const chainName = this.getName();
    const stackSpecificChainConfig = this.isOpStack() ? opStackChainConfig : undefined;

    return defineChain({
      ...stackSpecificChainConfig,
      id: this.chainId,
      name: chainName,
      network: this.getSlug(),
      nativeCurrency: this.options.nativeCurrency,
      rpcUrls: {
        default: { http: [this.getRpcUrl()] },
        public: { http: [this.getRpcUrl()] },
      },
      blockExplorers: {
        default: {
          name: `${chainName} Explorer`,
          url: this.getExplorerUrl(),
        },
      },
      contracts: { ...stackSpecificChainConfig?.contracts, ...this.getDeployedContracts() },
      testnet: this.isTestnet(),
    });
  }

  createViemPublicClient(
    overrideUrl?: string | string[],
    blockNumber?: bigint,
    httpOptions?: { timeout?: number; retryCount?: number },
  ): PublicClient {
    // Some chains run out of gas with the default multicall settings.
    const multicallOverrides: Record<number, boolean | { batchSize: number }> = {
      [ChainId.Mantle]: { batchSize: 256 },
      [ChainId.Oasys]: false,
    };

    const transportOverrides: Record<number, any> = {
      // Kasplex's RPC does not handle batch requests properly
      [ChainId.KasplexZkEVM]: { batch: false },
    };

    const shouldUseDeployless = () => {
      const multicall3 = this.getDeployedContracts()?.multicall3;
      if (!multicall3) return true;
      if (isNullish(blockNumber)) return false;
      if (isNullish(multicall3.blockCreated)) return false;
      return BigInt(multicall3.blockCreated) > blockNumber;
    };

    const multicallConfig = shouldUseDeployless() ? { deployless: true } : true;
    const transportOptions = {
      ...(transportOverrides[this.chainId] ?? { batch: { wait: 10, batchSize: 10 } }),
      ...httpOptions,
    };

    // Every known endpoint for the chain, not just the first.
    //
    // Public RPCs are often dead, rate limited, or refuse browser requests, and taking only the first entry
    // means one bad host makes the whole chain look unreachable. A fallback transport moves on to the next,
    // which matters most for exactly the people who have configured no provider key.
    const rpcUrls = (overrideUrl ? [overrideUrl].flat() : this.getRpcUrls()).slice(0, MAX_FALLBACK_RPC_URLS);

    return createPublicClient({
      pollingInterval: 4 * SECOND,
      chain: this.getViemChainConfig(),
      transport:
        rpcUrls.length > 1
          ? // Each endpoint gets a single attempt rather than viem's default three. The fallback chain is
            // itself the redundancy, and retrying a dead host three times with backoff burns the caller's
            // timeout before failover ever reaches a working endpoint.
            fallback(rpcUrls.map((url) => http(url, { ...transportOptions, retryCount: 1 })))
          : http(rpcUrls[0], transportOptions),
      batch: { multicall: multicallOverrides[this.chainId] ?? multicallConfig },
    });
  }
}
