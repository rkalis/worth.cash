import { DAY } from 'lib/utils/time';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveEarliestPricedTimestamp = vi.fn();
const transferEventsToArray = vi.fn();
const fetchHistoricalSeriesForContract = vi.fn();
const fetchHistoricalSeriesForCoin = vi.fn();

// Rows the tests vary; everything else the database is asked for stays empty.
let storedTokens: unknown[] = [];
let storedPrices: unknown[] = [];

// Only the network-touching parts are stubbed. priceAt and the window maths stay real.
vi.mock('lib/prices/historical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lib/prices/historical')>()),
  resolveEarliestPricedTimestamp: () => resolveEarliestPricedTimestamp(),
  fetchHistoricalSeriesForContract: (...args: unknown[]) => fetchHistoricalSeriesForContract(...args),
  fetchHistoricalSeriesForCoin: (...args: unknown[]) => fetchHistoricalSeriesForCoin(...args),
}));

vi.mock('lib/history/blocks', () => ({
  resolveBlockAtTimestamp: async () => 300,
  resolveBlocksForTimestamps: async (chainIds: number[], timestamps: number[]) =>
    new Map(chainIds.map((chainId) => [chainId, timestamps.map(() => 300)])),
}));

vi.mock('lib/db', () => ({
  db: {
    transferEvents: { toArray: () => transferEventsToArray() },
    exchangeAccounts: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
    exchangeLedger: { toArray: async () => [] },
    tokens: { toArray: async () => storedTokens },
    prices: { toArray: async () => storedPrices },
    wallets: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
    nftCollections: { toArray: async () => [], bulkGet: async () => [] },
    snapshots: { put: vi.fn() },
    manualBalances: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
    manualLedger: { toArray: async () => [] },
    // The lens the reconstructed total is assembled under: empty preferences, no live artwork.
    tokenOverrides: { toArray: async () => [] },
    categoryAssignments: { toArray: async () => [] },
    settings: { get: async () => undefined },
  },
}));

const { reconstructSnapshotAt } = await import('lib/history/reconstruct');

beforeEach(() => {
  resolveEarliestPricedTimestamp.mockReset();
  resolveEarliestPricedTimestamp.mockResolvedValue(null);
  transferEventsToArray.mockReset();
  transferEventsToArray.mockResolvedValue([]);
  fetchHistoricalSeriesForContract.mockReset();
  fetchHistoricalSeriesForContract.mockImplementation(async (_chainId, _address, priceKey) => ({
    priceKey,
    points: [{ timestamp: 0, priceUsd: 2 }],
  }));
  fetchHistoricalSeriesForCoin.mockReset();
  fetchHistoricalSeriesForCoin.mockImplementation(async (_id, priceKey) => ({
    priceKey,
    points: [{ timestamp: 0, priceUsd: 2 }],
  }));
  storedTokens = [];
  storedPrices = [];
});

describe('reconstructSnapshotAt', () => {
  it('refuses a moment in the future', async () => {
    await expect(reconstructSnapshotAt(Date.now() + DAY)).rejects.toThrow(/future/i);
  });

  // Every asset would come back unpriced, and a point worth nothing looks exactly like a portfolio that
  // really was empty. Refusing says which it is.
  it('refuses a moment older than the CoinGecko plan will price', async () => {
    const earliest = Date.now() - 365 * DAY;
    resolveEarliestPricedTimestamp.mockResolvedValue(earliest);

    const result = await reconstructSnapshotAt(earliest - DAY);

    expect(result.status).toBe('beyond-plan-limit');
    expect(result.earliestPricedTimestamp).toBe(earliest);
    expect(result.totalUsd).toBe(0);
  });

  it('does not refuse a moment the plan still covers', async () => {
    resolveEarliestPricedTimestamp.mockResolvedValue(Date.now() - 365 * DAY);

    const result = await reconstructSnapshotAt(Date.now() - 30 * DAY);

    expect(result.status).not.toBe('beyond-plan-limit');
  });

  // Nothing stored means nothing can be said about that moment, which is not the same as it being worth
  // zero. Writing a zero would turn "we do not know" into a claim.
  it('reports no holdings rather than writing a zero when there is no history', async () => {
    const result = await reconstructSnapshotAt(Date.now() - DAY);

    expect(result.status).toBe('no-holdings');
    expect(result.totalUsd).toBe(0);
  });
});

const OWNER = '0x1111111111111111111111111111111111111111';
const HELD = '0x00000000000000000000000000000000000000aa';
const SOLD = '0x00000000000000000000000000000000000000bb';
const UNPRICED = '0x00000000000000000000000000000000000000cc';

const token = (address: string, overrides: Record<string, unknown> = {}) => ({
  id: `1:${address}`,
  chainId: 1,
  address,
  standard: 'erc20',
  symbol: 'TKN',
  decimals: 18,
  isSpam: 0,
  metadataUpdatedAt: 0,
  ...overrides,
});

const transfer = (address: string, blockNumber: number, from: string, to: string) => ({
  id: `1:${OWNER}:0x${address}${blockNumber}:0`,
  chainId: 1,
  owner: OWNER,
  token: address,
  standard: 'erc20',
  from,
  to,
  amount: '1000000000000000000',
  blockNumber,
  transactionIndex: 0,
  logIndex: 0,
  transactionHash: `0x${blockNumber}`,
});

const ZERO = '0x0000000000000000000000000000000000000000';

// Blocks resolve to 300, so anything transferred away before then is no longer held at the requested moment.
describe('reconstructSnapshotAt price lookups', () => {
  it('does not price an asset that had already been sold by that moment', async () => {
    storedTokens = [token(HELD), token(SOLD)];
    transferEventsToArray.mockResolvedValue([
      transfer(HELD, 100, ZERO, OWNER),
      transfer(SOLD, 100, ZERO, OWNER),
      transfer(SOLD, 200, OWNER, ZERO),
    ]);

    await reconstructSnapshotAt(Date.now() - DAY);

    const pricedKeys = fetchHistoricalSeriesForContract.mock.calls.map(([, address]) => address);
    expect(pricedKeys).toEqual([HELD]);
  });

  // A stored null is CoinGecko having answered "there is no price for this". The archive will not have one
  // either, so the request is spent to be told what we already know.
  it('does not price an asset already known to have no current price', async () => {
    storedTokens = [token(HELD), token(UNPRICED)];
    storedPrices = [
      { id: `1:${HELD}`, priceUsd: 5, updatedAt: 0 },
      { id: `1:${UNPRICED}`, priceUsd: null, updatedAt: 0 },
    ];
    transferEventsToArray.mockResolvedValue([transfer(HELD, 100, ZERO, OWNER), transfer(UNPRICED, 100, ZERO, OWNER)]);

    await reconstructSnapshotAt(Date.now() - DAY);

    const pricedKeys = fetchHistoricalSeriesForContract.mock.calls.map(([, address]) => address);
    expect(pricedKeys).toEqual([HELD]);
  });

  // Never having asked is not the same as having been told there is none.
  it('still prices an asset we have never looked up a current price for', async () => {
    storedTokens = [token(HELD)];
    storedPrices = [];
    transferEventsToArray.mockResolvedValue([transfer(HELD, 100, ZERO, OWNER)]);

    await reconstructSnapshotAt(Date.now() - DAY);

    expect(fetchHistoricalSeriesForContract).toHaveBeenCalledTimes(1);
  });

  // A listed token carries its current price under its coin id rather than its contract, so both keys have
  // to be consulted before deciding it is unpriced.
  it('keeps a listed token whose price is stored under its coin id', async () => {
    storedTokens = [token(HELD, { coingeckoId: 'some-coin' })];
    storedPrices = [
      { id: `1:${HELD}`, priceUsd: null, updatedAt: 0 },
      { id: 'coingecko:some-coin', priceUsd: 12, updatedAt: 0 },
    ];
    transferEventsToArray.mockResolvedValue([transfer(HELD, 100, ZERO, OWNER)]);

    await reconstructSnapshotAt(Date.now() - DAY);

    expect(fetchHistoricalSeriesForContract).toHaveBeenCalledTimes(1);
  });

  it('drops a listed token when neither of its price keys has a price', async () => {
    storedTokens = [token(HELD, { coingeckoId: 'some-coin' })];
    storedPrices = [
      { id: `1:${HELD}`, priceUsd: null, updatedAt: 0 },
      { id: 'coingecko:some-coin', priceUsd: null, updatedAt: 0 },
    ];
    transferEventsToArray.mockResolvedValue([transfer(HELD, 100, ZERO, OWNER)]);

    await reconstructSnapshotAt(Date.now() - DAY);

    expect(fetchHistoricalSeriesForContract).not.toHaveBeenCalled();
  });

  // The report says how many held assets could not be valued. Tokens sold long ago were never candidates.
  it('counts only held assets as unpriced', async () => {
    storedTokens = [token(HELD), token(SOLD), token(UNPRICED)];
    storedPrices = [{ id: `1:${UNPRICED}`, priceUsd: null, updatedAt: 0 }];
    transferEventsToArray.mockResolvedValue([
      transfer(HELD, 100, ZERO, OWNER),
      transfer(SOLD, 100, ZERO, OWNER),
      transfer(SOLD, 200, OWNER, ZERO),
      transfer(UNPRICED, 100, ZERO, OWNER),
    ]);

    const result = await reconstructSnapshotAt(Date.now() - DAY);

    expect(result.unpricedAssetCount).toBe(1);
  });
});
