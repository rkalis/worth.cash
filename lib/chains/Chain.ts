import { ChainId, getChain } from '@revoke.cash/chains';
import { getOpenSeaChainSlug } from 'lib/chains/opensea';
import { getApiKey, getRuntimeSettings } from 'lib/settings/runtime';
import type { EtherscanPlatform, RateLimit } from 'lib/types';
import { isNullish } from 'lib/utils';
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
  name?: string;
  logoUrl?: string;
  infoUrl?: string;
  nativeToken?: string;
  nativeTokenCoingeckoId?: string;
  coingeckoNetworkId?: string;
  explorerUrl?: string;
  etherscanCompatibleApiUrl?: string;
  rpc?: {
    main?: string | string[];
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

// The public RPC lists from chainid.network contain entries that are templates rather than URLs, such as
// `https://mainnet.infura.io/v3/${INFURA_API_KEY}`. They are meant to be filled in by whoever consumes the
// list, and using one verbatim produces a request to a literal `${...}` path. revoke.cash never notices,
// because it always has an Alchemy key configured and so never falls through to the public list.
// Enough to ride out a few dead hosts without turning one failed call into a long serial retry chain.
const MAX_FALLBACK_RPC_URLS = 5;

const hasUnresolvedTemplate = (url: string): boolean => url.includes('${') || url.includes('%7B');

// The public lists mix transports, offering `wss://` endpoints alongside `https://` ones. We only ever build
// HTTP clients, and handing a WebSocket URL to an HTTP transport produces a failure that reads as the
// endpoint being down.
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
    const name = this.options.name ?? getChain(this.chainId)?.name ?? `Chain ID ${this.chainId}`;

    if (!this.isSupported()) {
      return `${name} (Unsupported)`;
    }

    return name;
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

  getLogoUrl(): string | undefined {
    return this.options.logoUrl ?? getChain(this.chainId)?.iconURL;
  }

  getExplorerUrl(): string {
    const [explorer] = getChain(this.chainId)?.explorers ?? [];
    return this.options.explorerUrl ?? explorer?.url;
  }

  getFreeRpcUrl(): string {
    const [rpcUrl] = (getChain(this.chainId)?.rpc ?? []).filter(isUsableRpcUrl);
    return this.options.rpc?.free ?? rpcUrl ?? this.getRpcUrl();
  }

  getRpcUrls(): string[] {
    const userOverride = getRuntimeSettings().rpcOverrides[this.chainId];

    // Unusable entries are dropped rather than ranked last, since a request to one fails in a way that looks
    // like the chain being down rather than like a bad URL.
    const baseRpcUrls = (getChain(this.chainId)?.rpc ?? []).filter(isUsableRpcUrl);

    const specifiedRpcUrls = [this.options.rpc?.main]
      .flat()
      .filter((url) => !isNullish(url))
      .map((url) => resolveRpcPlaceholders(url))
      .filter((url): url is string => !isNullish(url) && isUsableRpcUrl(url));

    // A user-configured RPC always wins: it is the only one we know has the rate limits they paid for.
    return [...(userOverride ? [userOverride] : []), ...specifiedRpcUrls, ...baseRpcUrls];
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
    const configuredLogsRpc = this.options.rpc?.logs ? resolveRpcPlaceholders(this.options.rpc.logs) : undefined;
    const rpcUrls = this.getRpcUrls();

    if (!configuredLogsRpc || !isUsableRpcUrl(configuredLogsRpc)) return rpcUrls;
    return [configuredLogsRpc, ...rpcUrls.filter((url) => url !== configuredLogsRpc)];
  }

  getInfoUrl(): string | undefined {
    const mainnetChainId = this.getCorrespondingMainnetChainId() ?? -1;
    return this.options.infoUrl ?? getChain(mainnetChainId)?.infoURL ?? getChain(this.chainId)?.infoURL;
  }

  getNativeToken(): string {
    return (this.options.nativeToken ?? getChain(this.chainId)?.nativeCurrency?.symbol) as string;
  }

  getNativeTokenDecimals(): number {
    return getChain(this.chainId)?.nativeCurrency?.decimals ?? 18;
  }

  getNativeTokenCoingeckoId(): string | undefined {
    return this.options.nativeTokenCoingeckoId ?? (this.getNativeToken() === 'ETH' ? 'ethereum' : undefined);
  }

  // The CoinGecko on-chain (GeckoTerminal) network identifier, used to price tokens by contract address.
  getCoingeckoNetworkId(): string | undefined {
    return this.options.coingeckoNetworkId;
  }

  // Backed by the OpenSea slug map rather than by per-chain config, since only ~20 chains have one.
  getOpenSeaChainSlug(): string | undefined {
    return getOpenSeaChainSlug(this.chainId);
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
    const chainInfo = getChain(this.chainId);
    const chainName = this.getName();
    const fallbackNativeCurrency = { name: chainName, symbol: this.getNativeToken(), decimals: 18 };

    const stackSpecificChainConfig = this.isOpStack() ? opStackChainConfig : undefined;

    return defineChain({
      ...stackSpecificChainConfig,
      id: this.chainId,
      name: chainName,
      network: this.getSlug(),
      nativeCurrency: chainInfo?.nativeCurrency ?? fallbackNativeCurrency,
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
      [ChainId.OasysMainnet]: false,
    };

    const transportOverrides: Record<number, any> = {
      // Kasplex's RPC does not handle batch requests properly
      202555: { batch: false },
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
    // Public RPC lists are full of hosts that are dead, rate limited, or refuse browser requests, and taking
    // only the first entry means one bad host makes the whole chain look unreachable. A fallback transport
    // moves on to the next, which matters most for exactly the people who have configured no provider key.
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
