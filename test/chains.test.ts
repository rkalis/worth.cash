import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, getChainConfig, getChainConfigSafe, SUPPORTED_CHAINS } from 'lib/chains';
import type { Chain } from 'lib/chains/Chain';
import { ChainId } from 'lib/chains/ids';
import { setRuntimeSettings } from 'lib/settings/runtime';
import { type AppSettings, DEFAULT_SETTINGS } from 'lib/settings/types';
import { afterEach, describe, expect, it } from 'vitest';

const ALL_CHAINS: Chain[] = Object.values(CHAINS);

const useSettings = (overrides: Partial<AppSettings>) => setRuntimeSettings({ ...DEFAULT_SETTINGS, ...overrides });

const PROVIDER_KEYS = { alchemy: 'alchemy-test-key', drpc: 'drpc-test-key' };

const hasTemplate = (url: string | undefined): boolean => Boolean(url?.includes('{') || url?.includes('%7B'));

describe('chain RPC resolution', () => {
  afterEach(() => setRuntimeSettings(DEFAULT_SETTINGS));

  // Keyed RPC URLs carry a `{ALCHEMY_API_KEY}` style placeholder. Used verbatim one produces a request to a
  // literal `{...}` path, which fails in a way that reads as the chain being unreachable rather than as a
  // missing key. So a placeholder is either filled in from settings or the URL is dropped.
  it('never returns an RPC URL containing an unresolved placeholder, with or without provider keys', () => {
    const findOffenders = () =>
      ALL_CHAINS.flatMap((chain) =>
        chain
          .getRpcUrls()
          .filter(hasTemplate)
          .map((url) => `${chain.chainId}: ${url}`),
      );

    expect(findOffenders()).toEqual([]);

    useSettings({ apiKeys: PROVIDER_KEYS });
    expect(findOffenders()).toEqual([]);
  });

  // An HTTP client handed a `wss://` URL fails in a way that reads as the endpoint being down.
  it('never returns a non-HTTP RPC URL', () => {
    const offenders = ALL_CHAINS.flatMap((chain) =>
      chain
        .getRpcUrls()
        .filter((url) => !url.startsWith('http://') && !url.startsWith('https://'))
        .map((url) => `${chain.chainId}: ${url}`),
    );

    expect(offenders).toEqual([]);
  });

  it('never offers a templated URL as the free RPC either', () => {
    const offenders = ALL_CHAINS.map((chain) => chain.getFreeRpcUrl()).filter(hasTemplate);

    expect(offenders).toEqual([]);
  });

  // Dropping a keyed URL must not leave a major chain with no RPC at all: the keyless free RPC takes over.
  it('still resolves an RPC for the major chains without any provider key', () => {
    const majorChainIds = [
      ChainId.Ethereum,
      ChainId.Optimism,
      ChainId.BNBChain,
      ChainId.Polygon,
      ChainId.Base,
      ChainId.Arbitrum,
    ] as const;

    for (const chainId of majorChainIds) {
      expect(getChainConfig(chainId).getRpcUrl(), `chain ${chainId}`).toBeTruthy();
    }
  });

  it('falls back to the keyless free RPC when the main RPC needs a key that is not configured', () => {
    expect(getChainConfig(ChainId.Ethereum).getRpcUrls()).toEqual(['https://eth.drpc.org']);
  });

  it('tries the main RPC first and the free RPC after it once the key is configured', () => {
    useSettings({ apiKeys: PROVIDER_KEYS });

    expect(getChainConfig(ChainId.Ethereum).getRpcUrls()).toEqual([
      'https://eth-mainnet.g.alchemy.com/v2/alchemy-test-key',
      'https://eth.drpc.org',
    ]);
    expect(getChainConfig(ChainId.Viction).getRpcUrls()).toEqual([
      'https://lb.drpc.live/viction/drpc-test-key',
      'https://rpc.viction.xyz',
    ]);
  });

  it('puts a user RPC override ahead of every configured RPC', () => {
    useSettings({ apiKeys: PROVIDER_KEYS, rpcOverrides: { [ChainId.Ethereum]: 'https://node.example.com' } });

    expect(getChainConfig(ChainId.Ethereum).getRpcUrls()).toEqual([
      'https://node.example.com',
      'https://eth-mainnet.g.alchemy.com/v2/alchemy-test-key',
      'https://eth.drpc.org',
    ]);
  });

  // Trying the same host twice in a row is no failover, and it spends one of the few fallback slots.
  it('lists each endpoint once when an override repeats a configured RPC', () => {
    useSettings({ rpcOverrides: { [ChainId.Ethereum]: 'https://eth.drpc.org' } });

    expect(getChainConfig(ChainId.Ethereum).getRpcUrls()).toEqual(['https://eth.drpc.org']);
  });

  it('lists every chain without duplicate endpoints', () => {
    useSettings({ apiKeys: PROVIDER_KEYS });

    const offenders = ALL_CHAINS.filter((chain) => new Set(chain.getRpcUrls()).size !== chain.getRpcUrls().length);

    expect(offenders.map((chain) => chain.chainId)).toEqual([]);
  });
});

describe('chain metadata', () => {
  // The frozen chain-list package this app used to read from gave HyperEVM the Wanchain Testnet's RPC and
  // native currency. Every chain now documents its own.
  it('documents HyperEVM with its own name, native currency and RPC', () => {
    const hyperEvm = getChainConfig(ChainId.HyperEVM);

    expect(hyperEvm.getName()).toBe('HyperEVM');
    expect(hyperEvm.getNativeToken()).toBe('HYPE');
    expect(hyperEvm.getNativeTokenDecimals()).toBe(18);
    expect(hyperEvm.getViemChainConfig().nativeCurrency).toEqual({ name: 'HYPE', symbol: 'HYPE', decimals: 18 });
    expect(hyperEvm.getRpcUrls()).toEqual(['https://rpc.hyperliquid.xyz/evm']);
  });

  it('no longer documents the chains that lost support', () => {
    const removedChainIds = [25, 666666666, 245022934, 1666600000];

    expect(removedChainIds.filter((chainId) => getChainConfigSafe(chainId) !== undefined)).toEqual([]);
    expect(SUPPORTED_CHAINS.filter((chainId) => removedChainIds.includes(chainId))).toEqual([]);
  });

  it('points every chain at a logo that exists', () => {
    const missingLogos = ALL_CHAINS.map((chain) => chain.getLogoUrl()).filter(
      (logoUrl) => !existsSync(join(import.meta.dirname, '..', 'public', logoUrl)),
    );

    expect(missingLogos).toEqual([]);
  });
});
