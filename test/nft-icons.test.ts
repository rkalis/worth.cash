import type { StoredNftCollection } from 'lib/db/schema';
import type { WhoisChainLookup } from 'lib/whois';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const APES = '0x00000000000000000000000000000000000000c1';
const PUNKS = '0x00000000000000000000000000000000000000c2';
const WHOIS_ICON = 'https://i2c.seadn.io/apes.png';
const COINGECKO_ICON = 'https://coin-images.coingecko.com/apes.png';

let stored = new Map<string, StoredNftCollection>();
const bulkUpdate = vi.fn();
const lookupWhoisTokensForChain = vi.fn();

// The table is a plain map, so each test reads back exactly what the sync wrote.
vi.mock('lib/db', () => ({
  db: {
    nftCollections: {
      bulkGet: async (keys: string[]) => keys.map((key) => stored.get(key)),
      bulkUpdate: async (updates: Array<{ key: string; changes: Partial<StoredNftCollection> }>) => {
        bulkUpdate(updates);
        for (const { key, changes } of updates) {
          const existing = stored.get(key);
          if (existing) stored.set(key, { ...existing, ...changes });
        }
        return updates.length;
      },
    },
  },
}));

vi.mock('lib/whois', () => ({
  lookupWhoisTokensForChain: (...args: unknown[]) => lookupWhoisTokensForChain(...args),
}));

const { syncCollectionIcons } = await import('lib/nfts/icons');

const collection = (address: string, overrides: Partial<StoredNftCollection> = {}): StoredNftCollection => ({
  id: `1:${address}`,
  chainId: 1,
  address,
  standard: 'erc721',
  metadataUpdatedAt: 0,
  ...overrides,
});

const seed = (...rows: StoredNftCollection[]) => {
  stored = new Map(rows.map((row) => [row.id, row]));
};

// A whois answer: an address mapped to a logo was found, one mapped to undefined was confirmed absent, and
// any address left out did not get an answer at all.
const whoisAnswer = (answers: Record<string, string | undefined>): WhoisChainLookup => ({
  found: new Map(
    Object.entries(answers)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([address, logoUrl]) => [address, { logoUrl }]),
  ),
  answered: new Set(Object.keys(answers)),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  stored = new Map();
  bulkUpdate.mockReset();
  lookupWhoisTokensForChain.mockReset();
  lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({}));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('syncCollectionIcons', () => {
  it('stores the whois icon and remembers that it asked', async () => {
    seed(collection(APES));
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [APES]: WHOIS_ICON }));

    const found = await syncCollectionIcons(1, [APES]);

    expect(found).toBe(1);
    expect(stored.get(`1:${APES}`)).toMatchObject({ whoisImageUrl: WHOIS_ICON, whoisCheckedAt: NOW });
  });

  // The whole point of the timestamp: one request per collection, not one per sync.
  it('does not ask again about a collection it checked recently', async () => {
    seed(collection(APES, { whoisCheckedAt: NOW - WEEK }));

    expect(await syncCollectionIcons(1, [APES])).toBe(0);
    expect(lookupWhoisTokensForChain).not.toHaveBeenCalled();
    expect(bulkUpdate).not.toHaveBeenCalled();
  });

  it('asks again once its answer has gone stale, and only about those collections', async () => {
    seed(collection(APES, { whoisCheckedAt: NOW - 5 * WEEK }), collection(PUNKS, { whoisCheckedAt: NOW - WEEK }));

    await syncCollectionIcons(1, [APES, PUNKS]);

    expect(lookupWhoisTokensForChain).toHaveBeenCalledWith(1, [APES]);
  });

  // An outage is not an answer. Recording it as one would leave the collection without an icon for a month.
  it('leaves a collection whose lookup failed unchecked, so the next sync asks again', async () => {
    seed(collection(APES), collection(PUNKS));
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [PUNKS]: undefined }));

    await syncCollectionIcons(1, [APES, PUNKS]);

    expect(stored.get(`1:${APES}`)?.whoisCheckedAt).toBeUndefined();
    expect(stored.get(`1:${PUNKS}`)?.whoisCheckedAt).toBe(NOW);

    lookupWhoisTokensForChain.mockClear();
    await syncCollectionIcons(1, [APES, PUNKS]);

    expect(lookupWhoisTokensForChain).toHaveBeenCalledWith(1, [APES]);
  });

  it('records nothing when the whole lookup fails', async () => {
    seed(collection(APES));
    lookupWhoisTokensForChain.mockRejectedValue(new Error('network down'));

    await syncCollectionIcons(1, [APES]);

    expect(bulkUpdate).not.toHaveBeenCalled();
    expect(stored.get(`1:${APES}`)?.whoisCheckedAt).toBeUndefined();
  });

  it("clears an icon the dataset has since dropped, leaving CoinGecko's to show", async () => {
    seed(
      collection(APES, {
        whoisImageUrl: WHOIS_ICON,
        coingeckoImageUrl: COINGECKO_ICON,
        whoisCheckedAt: NOW - 5 * WEEK,
      }),
    );
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [APES]: undefined }));

    await syncCollectionIcons(1, [APES]);

    expect(stored.get(`1:${APES}`)?.whoisImageUrl).toBeUndefined();
    expect(stored.get(`1:${APES}`)?.coingeckoImageUrl).toBe(COINGECKO_ICON);
  });

  it('never touches the icon CoinGecko supplied', async () => {
    seed(collection(APES, { coingeckoImageUrl: COINGECKO_ICON }));
    lookupWhoisTokensForChain.mockResolvedValue(whoisAnswer({ [APES]: WHOIS_ICON }));

    await syncCollectionIcons(1, [APES]);

    expect(stored.get(`1:${APES}`)).toMatchObject({ whoisImageUrl: WHOIS_ICON, coingeckoImageUrl: COINGECKO_ICON });
  });

  it('skips collections the metadata step has not recorded yet', async () => {
    expect(await syncCollectionIcons(1, [APES])).toBe(0);
    expect(lookupWhoisTokensForChain).not.toHaveBeenCalled();
  });
});
