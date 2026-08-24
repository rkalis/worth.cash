import { beforeEach, describe, expect, it, vi } from 'vitest';

const kyGet = vi.fn();

vi.mock('lib/ky', () => ({
  default: { get: (...args: unknown[]) => kyGet(...args) },
  kyQueue: { add: (fn: () => unknown) => fn() },
}));

const { fetchWhoisTokenMetadata, fetchWhoisTokenMetadataForChain } = await import('lib/whois');

// Deliberately lowercase, which is how addresses are stored in IndexedDB.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDC_CHECKSUMMED = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const respondWith = (payload: unknown) => kyGet.mockReturnValue({ json: () => Promise.resolve(payload) });

describe('fetchWhoisTokenMetadata', () => {
  beforeEach(() => kyGet.mockReset());

  it('maps the dataset fields onto our token metadata', async () => {
    respondWith({
      symbol: 'USDC',
      decimals: 6,
      logoURI: 'https://assets.coingecko.com/coins/images/6319/small/USDC.png',
    });

    expect(await fetchWhoisTokenMetadata(1, USDC)).toEqual({
      symbol: 'USDC',
      decimals: 6,
      logoUrl: 'https://assets.coingecko.com/coins/images/6319/small/USDC.png',
      isSpam: undefined,
    });
  });

  // The dataset is keyed by checksummed address. Requesting a lowercase one returns an empty object with a
  // 200, so getting this wrong is indistinguishable from the token being absent, and every token would
  // silently render without a logo.
  it('requests the checksummed address even when given a lowercase one', async () => {
    respondWith({ symbol: 'USDC' });

    await fetchWhoisTokenMetadata(1, USDC);

    expect(kyGet).toHaveBeenCalledWith(
      `https://whois.revoke.cash/generated/tokens/1/${USDC_CHECKSUMMED}.json`,
      expect.anything(),
    );
  });

  // An unknown token is served as `{}` with a 200 rather than as a 404.
  it('treats an empty object as no data', async () => {
    respondWith({});

    expect(await fetchWhoisTokenMetadata(1, USDC)).toBeUndefined();
  });

  // A real failure surfaces as a rejected promise from ky, not a synchronous throw.
  it('returns nothing when the request fails, rather than rejecting', async () => {
    kyGet.mockReturnValue({ json: () => Promise.reject(new Error('network')) });

    expect(await fetchWhoisTokenMetadata(1, USDC)).toBeUndefined();
  });

  it('carries through a curated spam flag', async () => {
    respondWith({ symbol: 'SCAM', isSpam: true });

    expect((await fetchWhoisTokenMetadata(1, USDC))?.isSpam).toBe(true);
  });
});

describe('fetchWhoisTokenMetadataForChain', () => {
  beforeEach(() => kyGet.mockReset());

  // Keyed lowercase on the way out, because that is how callers look tokens up.
  it('returns results keyed by lowercase address, omitting tokens with no data', async () => {
    const other = '0x4444444444444444444444444444444444444444';

    kyGet.mockImplementation((url: string) => ({
      json: () => Promise.resolve(url.includes(USDC_CHECKSUMMED) ? { symbol: 'USDC', logoURI: 'x.png' } : {}),
    }));

    const resolved = await fetchWhoisTokenMetadataForChain(1, [USDC, other] as never);

    expect([...resolved.keys()]).toEqual([USDC]);
    expect(resolved.get(USDC)?.logoUrl).toBe('x.png');
  });

  it('does no work for an empty token list', async () => {
    expect((await fetchWhoisTokenMetadataForChain(1, [])).size).toBe(0);
    expect(kyGet).not.toHaveBeenCalled();
  });
});
