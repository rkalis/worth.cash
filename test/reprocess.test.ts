import type { StoredManualBalance, StoredManualLedgerEntry, StoredSnapshot } from 'lib/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 24, 9, 0);

let snapshots: StoredSnapshot[] = [];
let manualBalances: StoredManualBalance[] = [];
let manualLedger: StoredManualLedgerEntry[] = [];
const bulkPut = vi.fn();
const resolveEarliestPricedTimestamp = vi.fn();
const fetchHistoricalSeriesForCoin = vi.fn();

vi.mock('lib/db', () => ({
  db: {
    snapshots: { orderBy: () => ({ toArray: async () => snapshots }), bulkPut: (rows: unknown) => bulkPut(rows) },
    manualBalances: { where: () => ({ equals: () => ({ toArray: async () => manualBalances }) }) },
    manualLedger: { toArray: async () => manualLedger },
    settings: { get: async () => undefined },
  },
}));

// priceAt stays real; only the network calls are stubbed.
vi.mock('lib/prices/historical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lib/prices/historical')>()),
  resolveEarliestPricedTimestamp: () => resolveEarliestPricedTimestamp(),
  fetchHistoricalSeriesForCoin: (...args: unknown[]) => fetchHistoricalSeriesForCoin(...args),
}));

const { reprocessManualBalances } = await import('lib/history/reprocess');

const snapshot = (daysAgo: number, positions: StoredSnapshot['positions']): StoredSnapshot => ({
  timestamp: NOW - daysAgo * DAY,
  totalUsd: positions.reduce((total, position) => total + position.valueUsd, 0),
  createdAt: 0,
  positions,
});

const chainPosition = (valueUsd: number) => ({
  priceKey: 'coin:ethereum',
  symbol: 'ETH',
  amount: 1,
  priceUsd: valueUsd,
  valueUsd,
  kind: 'token' as const,
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
    bulkPut.mockReset();
    resolveEarliestPricedTimestamp.mockReset();
    resolveEarliestPricedTimestamp.mockResolvedValue(null);
    fetchHistoricalSeriesForCoin.mockReset();
    // A flat 60,000 across the whole range keeps the arithmetic obvious.
    fetchHistoricalSeriesForCoin.mockImplementation(async (_id, priceKey) => ({
      priceKey,
      points: [{ timestamp: 0, priceUsd: 60000 }],
    }));

    snapshots = [snapshot(30, [chainPosition(1000)]), snapshot(10, [chainPosition(2000)])];
    manualBalances = [balance('balance-1')];
    manualLedger = [{ id: 'e1', balanceId: 'balance-1', kind: 'buy', amount: '0.5', timestamp: NOW - 20 * DAY }];
  });

  // The whole point: history recorded before the holding existed gets it folded in.
  it('folds a manual holding into the snapshots that follow its first entry', async () => {
    const result = await reprocessManualBalances();

    expect(result.status).toBe('updated');
    expect(result.snapshotsChanged).toBe(1);

    const [written] = bulkPut.mock.calls[0] as [StoredSnapshot[]];
    expect(written).toHaveLength(1);
    expect(written[0].timestamp).toBe(NOW - 10 * DAY);
    expect(written[0].totalUsd).toBe(2000 + 30000);
  });

  // A snapshot from before the holding was bought must stay as it was.
  it('leaves a snapshot predating the ledger untouched', async () => {
    await reprocessManualBalances();

    const [written] = bulkPut.mock.calls[0] as [StoredSnapshot[]];
    expect(written.some((row) => row.timestamp === NOW - 30 * DAY)).toBe(false);
  });

  it('never creates a snapshot', async () => {
    const before = snapshots.map((row) => row.timestamp);

    await reprocessManualBalances();

    const [written] = bulkPut.mock.calls[0] as [StoredSnapshot[]];
    for (const row of written) expect(before).toContain(row.timestamp);
  });

  // A point recorded at sync time holds balances read from the chain. Rebuilding those would trade a fact
  // for an estimate.
  it('leaves non-manual positions exactly as they were', async () => {
    await reprocessManualBalances();

    const [written] = bulkPut.mock.calls[0] as [StoredSnapshot[]];
    const tokenPositions = written[0].positions.filter((position) => position.kind === 'token');

    expect(tokenPositions).toEqual([chainPosition(2000)]);
  });

  // Running twice must converge rather than accumulate.
  it('is idempotent', async () => {
    await reprocessManualBalances();
    const [firstWrite] = bulkPut.mock.calls[0] as [StoredSnapshot[]];

    // Feed the result back in, as the database would hold it.
    snapshots = snapshots.map((row) => firstWrite.find((written) => written.timestamp === row.timestamp) ?? row);
    bulkPut.mockReset();

    const second = await reprocessManualBalances();

    expect(second.snapshotsChanged).toBe(0);
    expect(bulkPut).not.toHaveBeenCalled();
  });

  // Removing a balance should take its contribution back out on the next run.
  it('drops a holding that no longer exists', async () => {
    await reprocessManualBalances();
    const [firstWrite] = bulkPut.mock.calls[0] as [StoredSnapshot[]];
    snapshots = snapshots.map((row) => firstWrite.find((written) => written.timestamp === row.timestamp) ?? row);

    manualBalances = [];
    bulkPut.mockReset();

    await reprocessManualBalances();

    const [secondWrite] = bulkPut.mock.calls[0] as [StoredSnapshot[]];
    expect(secondWrite[0].positions.every((position) => position.kind !== 'manual')).toBe(true);
    expect(secondWrite[0].totalUsd).toBe(2000);
  });

  it('reports having nothing to work with when no snapshots exist', async () => {
    snapshots = [];

    expect((await reprocessManualBalances()).status).toBe('no-snapshots');
  });

  // An unpriceable holding is recorded at zero and counted, rather than silently inflating the total.
  it('records a holding with no price at zero and reports it', async () => {
    manualBalances = [balance('balance-1', { coingeckoId: undefined })];

    const result = await reprocessManualBalances();
    const [written] = bulkPut.mock.calls[0] as [StoredSnapshot[]];

    expect(result.unpricedPositionCount).toBe(1);
    expect(written[0].positions.find((position) => position.kind === 'manual')?.valueUsd).toBe(0);
    expect(written[0].totalUsd).toBe(2000);
  });

  it('reports the plan limit when snapshots reach past it', async () => {
    resolveEarliestPricedTimestamp.mockResolvedValue(NOW - 15 * DAY);

    expect((await reprocessManualBalances()).earliestPricedTimestamp).toBe(NOW - 15 * DAY);
  });

  // One request per coin for the whole history, not one per snapshot.
  it('fetches each coin once for the entire range', async () => {
    snapshots = [snapshot(30, []), snapshot(20, []), snapshot(10, []), snapshot(5, [])];

    await reprocessManualBalances();

    expect(fetchHistoricalSeriesForCoin).toHaveBeenCalledTimes(1);
    const [, , window] = fetchHistoricalSeriesForCoin.mock.calls[0];
    expect(window).toMatchObject({ from: NOW - 30 * DAY, to: NOW - 5 * DAY });
  });

  // A snapshot taken while the balance already existed recorded the spot price of that moment. Replacing it
  // with a daily historical point is the same trade this module refuses to make with on-chain figures.
  describe('the price a rebuilt manual holding is valued at', () => {
    const manualPosition = (priceKey: string, priceUsd: number | null) => ({
      priceKey,
      symbol: 'BTC',
      amount: 0.5,
      priceUsd,
      valueUsd: priceUsd === null ? 0 : 0.5 * priceUsd,
      kind: 'manual' as const,
    });

    it('keeps the price the snapshot recorded rather than re-fetching one', async () => {
      // Filed under the asset's identity, which is how recordCurrentSnapshot writes it.
      snapshots = [snapshot(10, [chainPosition(2000), manualPosition('coin:bitcoin', 64_000)])];

      await reprocessManualBalances();

      const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
      const manual = written.positions.find((position) => position.kind === 'manual');

      expect(manual?.priceUsd).toBe(64_000);
      expect(manual?.valueUsd).toBe(32_000);
    });

    it('falls back to the historical price when the point never held it', async () => {
      snapshots = [snapshot(10, [chainPosition(2000)])];

      await reprocessManualBalances();

      const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
      const manual = written.positions.find((position) => position.kind === 'manual');

      expect(manual?.priceUsd).toBe(60_000);
    });

    // A position previously written with no price is a question that was asked and not answered, not an
    // answer of "no price", so it gets asked again.
    it('asks again about a holding that was left unpriced', async () => {
      snapshots = [snapshot(10, [chainPosition(2000), manualPosition('manual:balance-1', null)])];

      await reprocessManualBalances();

      const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
      const manual = written.positions.find((position) => position.kind === 'manual');

      expect(manual?.priceUsd).toBe(60_000);
    });
  });
});
