import type { StoredToken } from 'lib/db/schema';
import type { WhoisChainLookup, WhoisTokenMetadata } from 'lib/whois';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;
const OWNER = '0x1111111111111111111111111111111111111111';
// Deliberately lowercase, which is how addresses are stored in IndexedDB.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
const USDC_LOGO = 'https://assets.coingecko.com/coins/images/6319/large/usdc.png';

// What every token answers on-chain, so the chain read always succeeds and only the whois answer varies.
const ON_CHAIN_METADATA: Record<string, unknown> = { symbol: 'TKN', name: 'Token', decimals: 18 };

let heldTokens: string[] = [];
let stored = new Map<string, StoredToken>();
const lookupWhoisTokensForChain = vi.fn();

// The table is a plain map, so each test reads back exactly what the sync wrote.
vi.mock('lib/db', () => ({
  db: {
    balances: {
      where: () => ({ equals: () => ({ toArray: async () => heldTokens.map((token) => ({ token })) }) }),
    },
    tokens: {
      bulkGet: async (keys: string[]) => keys.map((key) => stored.get(key)),
      bulkPut: async (rows: StoredToken[]) => {
        rows.forEach((row) => {
          stored.set(row.id, row);
        });
      },
      get: async (key: string) => stored.get(key),
      put: async (row: StoredToken) => {
        stored.set(row.id, row);
      },
    },
  },
}));

vi.mock('lib/chains', () => ({
  createViemPublicClientForChain: () => ({
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string }> }) =>
      contracts.map(({ functionName }) => ({ status: 'success', result: ON_CHAIN_METADATA[functionName] })),
  }),
  getChainConfig: () => ({
    getDeployedContracts: () => undefined,
    getNativeToken: () => 'ETH',
    getNativeTokenDecimals: () => 18,
    getNativeTokenCoingeckoId: () => 'ethereum',
    getLogoUrl: () => undefined,
  }),
}));

vi.mock('lib/prices/coin-ids', () => ({
  resolveCoinIdsForTokens: async () => new Map(),
}));

vi.mock('lib/whois', () => ({
  lookupWhoisTokensForChain: (...args: unknown[]) => lookupWhoisTokensForChain(...args),
}));

const { syncTokenMetadata } = await import('lib/sync/metadata');

const sync = () => syncTokenMetadata(1, OWNER);

const hold = (...tokens: string[]) => {
  heldTokens = tokens;
};

const storedToken = (address: string, overrides: Partial<StoredToken> = {}): StoredToken => ({
  id: `1:${address}`,
  chainId: 1,
  address,
  standard: 'erc20',
  symbol: 'TKN',
  name: 'Token',
  decimals: 18,
  isSpam: 0,
  metadataUpdatedAt: NOW - WEEK,
  ...overrides,
});

const seed = (...rows: StoredToken[]) => {
  stored = new Map(rows.map((row) => [row.id, row]));
};

// A whois answer: an address mapped to metadata was found, one mapped to undefined was confirmed absent, and
// any address left out did not get an answer at all.
const whoisAnswer = (answers: Record<string, WhoisTokenMetadata | undefined>): WhoisChainLookup => ({
  found: new Map(
    Object.entries(answers).filter((entry): entry is [string, WhoisTokenMetadata] => entry[1] !== undefined),
  ),
  answered: new Set(Object.keys(answers)),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  heldTokens = [];
  stored = new Map();
  lookupWhoisTokensForChain.mockReset();
  lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({}));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('syncTokenMetadata whois lookups', () => {
  it('applies the logo and curated spam verdict of a token the dataset knows, and remembers that it asked', async () => {
    hold(USDC);
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [USDC]: { logoUrl: USDC_LOGO, isSpam: true } }));

    await sync();

    expect(stored.get(`1:${USDC}`)).toMatchObject({ logoUrl: USDC_LOGO, isSpam: 1, whoisCheckedAt: NOW });
  });

  // Absence is a real answer, and re-asking every sync would never produce a better one.
  it('stamps a token the dataset confirmed absent, and does not ask about it again', async () => {
    hold(DAI);
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [DAI]: undefined }));

    await sync();

    expect(stored.get(`1:${DAI}`)?.whoisCheckedAt).toBe(NOW);

    lookupWhoisTokensForChain.mockClear();
    await sync();

    expect(lookupWhoisTokensForChain).not.toHaveBeenCalled();
  });

  // An outage is not an answer. Recording it as one would leave the token without a logo or a curated spam
  // verdict for a month.
  it('leaves a new token whose lookup failed unchecked, and asks about it again on the next sync', async () => {
    hold(USDC, DAI);
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [DAI]: undefined }));

    await sync();

    expect(stored.get(`1:${USDC}`)).toMatchObject({ decimals: 18, metadataUpdatedAt: NOW });
    expect(stored.get(`1:${USDC}`)?.whoisCheckedAt).toBeUndefined();
    expect(stored.get(`1:${DAI}`)?.whoisCheckedAt).toBe(NOW);

    vi.setSystemTime(NOW + HOUR);
    lookupWhoisTokensForChain.mockClear();
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [USDC]: { logoUrl: USDC_LOGO } }));
    await sync();

    expect(lookupWhoisTokensForChain).toHaveBeenCalledOnce();
    expect(lookupWhoisTokensForChain).toHaveBeenCalledWith(1, [USDC]);
    expect(stored.get(`1:${USDC}`)).toMatchObject({ logoUrl: USDC_LOGO, whoisCheckedAt: NOW + HOUR });
  });

  it('keeps the previous check time and logo of a refreshed token whose lookup failed', async () => {
    seed(storedToken(USDC, { logoUrl: USDC_LOGO, metadataUpdatedAt: NOW - 5 * WEEK, whoisCheckedAt: NOW - 5 * WEEK }));
    hold(USDC);

    await sync();

    expect(stored.get(`1:${USDC}`)).toMatchObject({
      logoUrl: USDC_LOGO,
      whoisCheckedAt: NOW - 5 * WEEK,
      metadataUpdatedAt: NOW,
    });

    lookupWhoisTokensForChain.mockClear();
    await sync();

    expect(lookupWhoisTokensForChain).toHaveBeenCalledWith(1, [USDC]);
  });

  // Tokens stored before whois existed are filled in by the backfill, which must tell failure from absence too.
  it('retries a backfill lookup that failed, and stamps one the dataset confirmed absent', async () => {
    seed(storedToken(USDC), storedToken(DAI));
    hold(USDC, DAI);
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [DAI]: undefined }));

    await sync();

    expect(stored.get(`1:${USDC}`)?.whoisCheckedAt).toBeUndefined();
    expect(stored.get(`1:${DAI}`)?.whoisCheckedAt).toBe(NOW);

    lookupWhoisTokensForChain.mockClear();
    await sync();

    expect(lookupWhoisTokensForChain).toHaveBeenCalledOnce();
    expect(lookupWhoisTokensForChain).toHaveBeenCalledWith(1, [USDC]);
  });

  it('records nothing as checked when the whole lookup rejects', async () => {
    hold(USDC);
    lookupWhoisTokensForChain.mockRejectedValue(new Error('network down'));

    await sync();

    expect(stored.get(`1:${USDC}`)).toMatchObject({ decimals: 18, metadataUpdatedAt: NOW });
    expect(stored.get(`1:${USDC}`)?.whoisCheckedAt).toBeUndefined();
  });
});
