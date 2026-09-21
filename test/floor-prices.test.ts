import type { StoredNftCollection } from 'lib/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const APES = '0x00000000000000000000000000000000000000c1';
const WHOIS_ICON = 'https://i2c.seadn.io/apes.png';
const COINGECKO_ICON = 'https://coin-images.coingecko.com/apes.png';

let stored = new Map<string, StoredNftCollection>();
const fetchCoinGeckoNftCollection = vi.fn();

// The table is a plain map, so each test reads back exactly what the floor step wrote.
vi.mock('lib/db', () => ({
  db: {
    nftCollections: {
      bulkGet: async (keys: string[]) => keys.map((key) => stored.get(key)),
      update: async (key: string, changes: Partial<StoredNftCollection>) => {
        const existing = stored.get(key);
        if (existing) stored.set(key, { ...existing, ...changes });
        return existing ? 1 : 0;
      },
    },
  },
}));

vi.mock('lib/nfts/coingecko', () => ({
  fetchCoinGeckoNftCollection: (...args: unknown[]) => fetchCoinGeckoNftCollection(...args),
}));

const { syncFloorPrices } = await import('lib/nfts/floor-prices');

const collection = (overrides: Partial<StoredNftCollection> = {}): StoredNftCollection => ({
  id: `1:${APES}`,
  chainId: 1,
  address: APES,
  standard: 'erc721',
  metadataUpdatedAt: 0,
  ...overrides,
});

beforeEach(() => {
  stored = new Map();
  fetchCoinGeckoNftCollection.mockReset();
});

describe('syncFloorPrices', () => {
  it("keeps CoinGecko's image in its own field alongside the floor", async () => {
    stored.set(`1:${APES}`, collection());
    fetchCoinGeckoNftCollection.mockResolvedValue({
      status: 'found',
      collection: { coingeckoNftId: 'apes', floorPriceUsd: 5000, imageUrl: COINGECKO_ICON },
    });

    await syncFloorPrices(1, [APES]);

    expect(stored.get(`1:${APES}`)).toMatchObject({ floorPriceUsd: 5000, coingeckoImageUrl: COINGECKO_ICON });
  });

  // The image comes with the answer whether or not there is a floor, so a collection whois does not know
  // still gets an icon.
  it('keeps the image when CoinGecko knows the collection but has no floor for it', async () => {
    stored.set(`1:${APES}`, collection());
    fetchCoinGeckoNftCollection.mockResolvedValue({
      status: 'found',
      collection: { coingeckoNftId: 'apes', imageUrl: COINGECKO_ICON },
    });

    await syncFloorPrices(1, [APES]);

    expect(stored.get(`1:${APES}`)).toMatchObject({ coingeckoNftId: 'apes', coingeckoImageUrl: COINGECKO_ICON });
    expect(stored.get(`1:${APES}`)?.floorPriceUsd).toBeUndefined();
  });

  // Precedence is decided when the portfolio is aggregated, so the floor step must never write the whois field.
  it('never touches the whois icon', async () => {
    stored.set(`1:${APES}`, collection({ whoisImageUrl: WHOIS_ICON }));
    fetchCoinGeckoNftCollection.mockResolvedValue({
      status: 'found',
      collection: { coingeckoNftId: 'apes', floorPriceUsd: 5000, imageUrl: COINGECKO_ICON },
    });

    await syncFloorPrices(1, [APES]);

    expect(stored.get(`1:${APES}`)).toMatchObject({ whoisImageUrl: WHOIS_ICON, coingeckoImageUrl: COINGECKO_ICON });
  });
});
