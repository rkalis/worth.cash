import type { StoredManualBalance, StoredManualLedgerEntry, StoredSnapshot } from 'lib/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let snapshots: StoredSnapshot[] = [];
// What the table holds by the time the write goes in, when that differs from what the run read.
let snapshotsAtWriteTime: StoredSnapshot[] | undefined;
let manualBalances: StoredManualBalance[] = [];
let manualLedger: StoredManualLedgerEntry[] = [];
const bulkPut = vi.fn();
const resolveEarliestPricedTimestamp = vi.fn();
const fetchHistoricalSeriesForCoin = vi.fn();

vi.mock('lib/db', () => ({
  db: {
    snapshots: {
      orderBy: () => ({ toArray: async () => snapshots }),
      bulkGet: async (keys: number[]) =>
        keys.map((key) => (snapshotsAtWriteTime ?? snapshots).find((row) => row.timestamp === key)),
      bulkPut: (rows: unknown) => bulkPut(rows),
    },
    manualBalances: { where: () => ({ equals: () => ({ toArray: async () => manualBalances }) }) },
    manualLedger: { toArray: async () => manualLedger },
    // The lens the totals are computed under: empty preferences, no live artwork.
    tokenOverrides: { toArray: async () => [] },
    categoryAssignments: { toArray: async () => [] },
    tokens: { toArray: async () => [] },
    nftCollections: { toArray: async () => [] },
    settings: { get: async () => undefined },
    transaction: async (_mode: string, _table: unknown, run: () => Promise<void>) => run(),
  },
}));

// priceAt stays real; only the network calls are stubbed.
vi.mock('lib/prices/historical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lib/prices/historical')>()),
  resolveEarliestPricedTimestamp: () => resolveEarliestPricedTimestamp(),
  fetchHistoricalSeriesForCoin: (...args: unknown[]) => fetchHistoricalSeriesForCoin(...args),
}));

const { reprocessManualBalances } = await import('lib/history/reprocess');

const FACTS = {
  balances: [],
  tokens: [],
  nftCollections: [],
  nftHoldings: [],
  exchangeBalances: [],
  exchangeAccounts: [],
  exchangeAssetCoingeckoIds: {},
};

const snapshot = (daysAgo: number, overrides: Partial<StoredSnapshot> = {}): StoredSnapshot => ({
  timestamp: NOW - daysAgo * DAY,
  totalUsd: 0,
  createdAt: 0,
  ...FACTS,
  prices: [],
  manualHoldings: [],
  ...overrides,
});

const balance = (id: string, overrides: Partial<StoredManualBalance> = {}): StoredManualBalance => ({
  id,
  symbol: 'BTC',
  location: 'Bitcoin',
  coingeckoId: 'bitcoin',
  createdAt: 0,
  enabled: 1,
  ...overrides,
});

describe('reprocessManualBalances', () => {
  beforeEach(() => {
    snapshotsAtWriteTime = undefined;
    bulkPut.mockReset();
    resolveEarliestPricedTimestamp.mockReset();
    resolveEarliestPricedTimestamp.mockResolvedValue(null);
    fetchHistoricalSeriesForCoin.mockReset();
    // A flat 60,000 across the whole range keeps the arithmetic obvious.
    fetchHistoricalSeriesForCoin.mockImplementation(async (_id: string, priceKey: string) => ({
      priceKey,
      points: [{ timestamp: 0, priceUsd: 60_000 }],
    }));

    snapshots = [snapshot(30), snapshot(10)];
    manualBalances = [balance('balance-1')];
    manualLedger = [{ id: 'e1', balanceId: 'balance-1', kind: 'buy', amount: '0.5', timestamp: NOW - 20 * DAY }];
  });

  it('folds a manual holding into the snapshots that follow its first entry', async () => {
    const result = await reprocessManualBalances();

    expect(result.status).toBe('updated');
    expect(result.snapshotsChanged).toBe(1);

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.timestamp).toBe(NOW - 10 * DAY);
    expect(written.manualHoldings).toEqual([
      expect.objectContaining({ balanceId: 'balance-1', symbol: 'BTC', amount: 0.5 }),
    ]);
    expect(written.prices).toContainEqual({ id: 'coingecko:bitcoin', priceUsd: 60_000 });
    expect(written.totalUsd).toBe(30_000);
  });

  it('keeps a price the snapshot already recorded rather than re-fetching one', async () => {
    snapshots = [snapshot(10, { prices: [{ id: 'coingecko:bitcoin', priceUsd: 64_000 }] })];

    await reprocessManualBalances();

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.prices).toContainEqual({ id: 'coingecko:bitcoin', priceUsd: 64_000 });
    expect(written.totalUsd).toBe(32_000);
  });

  // A previously stored null is a question without an answer, not an answer.
  it('asks again about a coin a point could not price before', async () => {
    snapshots = [snapshot(10, { prices: [{ id: 'coingecko:bitcoin', priceUsd: null }] })];

    await reprocessManualBalances();

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.prices).toContainEqual({ id: 'coingecko:bitcoin', priceUsd: 60_000 });
  });

  it('leaves the on-chain rows of a snapshot exactly as they were', async () => {
    const chainRow = { chainId: 1, owner: '0xaaa', token: '0xbbb', amount: '5' };
    snapshots = [snapshot(10, { balances: [chainRow] })];

    await reprocessManualBalances();

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.balances).toEqual([chainRow]);
  });

  it('converges: a second run over its own output changes nothing', async () => {
    await reprocessManualBalances();
    const firstWrite = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    snapshots = snapshots.map((row) => firstWrite.find((written) => written.timestamp === row.timestamp) ?? row);
    bulkPut.mockReset();

    const second = await reprocessManualBalances();

    expect(second.snapshotsChanged).toBe(0);
    expect(bulkPut).not.toHaveBeenCalled();
  });

  it('removes a holding whose balance was disabled, without touching the ledger', async () => {
    await reprocessManualBalances();
    const firstWrite = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    snapshots = snapshots.map((row) => firstWrite.find((written) => written.timestamp === row.timestamp) ?? row);
    bulkPut.mockReset();

    manualBalances = [];
    const result = await reprocessManualBalances();

    expect(result.snapshotsChanged).toBe(1);
    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.manualHoldings).toEqual([]);
  });

  it('reports having nothing to work with when no snapshots exist', async () => {
    snapshots = [];

    expect((await reprocessManualBalances()).status).toBe('no-snapshots');
  });

  it('reports the plan limit when snapshots reach beyond it', async () => {
    resolveEarliestPricedTimestamp.mockResolvedValue(NOW - 15 * DAY);

    const result = await reprocessManualBalances();

    expect(result.earliestPricedTimestamp).toBe(NOW - 15 * DAY);
  });

  // A sync can end mid-run and rewrite the same row; overwriting its version from stale rows would
  // silently discard that write.
  it('drops a snapshot another writer rewrote since it was read', async () => {
    snapshotsAtWriteTime = snapshots.map((row) => ({ ...row, createdAt: 999 }));

    await reprocessManualBalances();

    expect(bulkPut).not.toHaveBeenCalled();
  });
});
