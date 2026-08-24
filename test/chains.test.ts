import { getChainConfig, SUPPORTED_CHAINS } from 'lib/chains';
import { describe, expect, it } from 'vitest';

describe('chain RPC resolution', () => {
  // The public RPC lists carry entries like `https://mainnet.infura.io/v3/${INFURA_API_KEY}`, which are
  // templates for the consumer to fill in. Used verbatim they produce a request to a literal `${...}` path,
  // which fails in a way that reads as the chain being unreachable rather than as a missing key. Ethereum
  // and Arbitrum both listed one first, so with no Alchemy key configured they were the RPC we actually used.
  it('never returns an RPC URL containing an unresolved template', () => {
    const offenders = SUPPORTED_CHAINS.flatMap((chainId) =>
      getChainConfig(chainId as never)
        .getRpcUrls()
        .filter((url) => url.includes('${') || url.includes('%7B'))
        .map((url) => `${chainId}: ${url}`),
    );

    expect(offenders).toEqual([]);
  });

  // The public lists mix transports. An HTTP client handed a `wss://` URL fails in a way that reads as the
  // endpoint being down, and Ethereum listed one third in its list.
  it('never returns a non-HTTP RPC URL', () => {
    const offenders = SUPPORTED_CHAINS.flatMap((chainId) =>
      getChainConfig(chainId as never)
        .getRpcUrls()
        .filter((url) => !url.startsWith('http://') && !url.startsWith('https://'))
        .map((url) => `${chainId}: ${url}`),
    );

    expect(offenders).toEqual([]);
  });

  it('never offers a templated URL as the free RPC either', () => {
    const offenders = SUPPORTED_CHAINS.map((chainId) => getChainConfig(chainId as never).getFreeRpcUrl()).filter(
      (url) => url?.includes('${') || url?.includes('%7B'),
    );

    expect(offenders).toEqual([]);
  });

  // Dropping the bad entries must not leave a major chain with no RPC at all.
  it('still resolves an RPC for the major chains without any provider key', () => {
    for (const chainId of [1, 10, 56, 137, 8453, 42161]) {
      expect(getChainConfig(chainId as never).getRpcUrl(), `chain ${chainId}`).toBeTruthy();
    }
  });
});
