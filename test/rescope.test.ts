import type { SnapshotPosition, StoredSnapshot, StoredWallet } from 'lib/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let snapshots: StoredSnapshot[] = [];
// What the table holds by the time the write goes in, when that differs from what the run read.
let snapshotsAtWriteTime: StoredSnapshot[] | undefined;
let wallets: StoredWallet[] = [];
const bulkPut = vi.fn();
const fetchCoinSeries = vi.fn();
const readNativeBalances = vi.fn();
const resolveBlocks = vi.fn();

// Only the tables are stubbed; the real classification, subtraction and assembly run.
vi.mock('lib/db', () => ({
  db: {
    snapshots: {
      orderBy: () => ({ toArray: async () => snapshots }),
      bulkGet: async (keys: number[]) =>
        keys.map((key) => (snapshotsAtWriteTime ?? snapshots).find((row) => row.timestamp === key)),
      bulkPut: async (rows: StoredSnapshot[]) => bulkPut(rows),
    },
    wallets: { toArray: async () => wallets },
    tokens: { toArray: async () => [] },
    nftCollections: { toArray: async () => [] },
    transferEvents: { where: () => ({ anyOf: () => ({ toArray: async () => [] }) }) },
    balances: { where: () => ({ anyOf: () => ({ toArray: async () => [] }) }) },
    syncCursors: { where: () => ({ anyOf: () => ({ toArray: async () => [] }) }) },
    settings: { get: async () => undefined },
    transaction: async (_mode: string, _table: unknown, run: () => Promise<void>) => run(),
  },
}));

vi.mock('lib/history/blocks', () => ({
  resolveBlocksForTimestamps: (...args: unknown[]) => resolveBlocks(...args) ?? Promise.resolve(new Map()),
}));

vi.mock('lib/history/native-balances', () => ({
  readHistoricalNativeBalances: (...args: unknown[]) =>
    readNativeBalances(...args) ?? Promise.resolve({ series: [], chainsWithoutArchiveAccess: [] }),
}));

vi.mock('lib/prices/historical', () => ({
  fetchHistoricalSeriesForCoin: (...args: unknown[]) => fetchCoinSeries(...args) ?? Promise.resolve(undefined),
  fetchHistoricalSeriesForContract: async () => undefined,
  priceAt: () => null,
}));

const { reprocessWalletScope } = await import('lib/history/rescope');

const buildWallet = (address: string, addedAt: number): StoredWallet => ({ address, addedAt, enabled: 1 });

const buildPosition = (overrides: Partial<SnapshotPosition> = {}): SnapshotPosition => ({
  priceKey: 'coin:ethereum',
  symbol: 'ETH',
  amount: 10,
  priceUsd: 2000,
  valueUsd: 20_000,
  kind: 'token',
  ...overrides,
});

const buildSnapshot = (overrides: Partial<StoredSnapshot> = {}): StoredSnapshot => ({
  timestamp: 1_000,
  totalUsd: 20_000,
  createdAt: 1_000,
  positions: [buildPosition()],
  ...overrides,
});

beforeEach(() => {
  snapshots = [];
  snapshotsAtWriteTime = undefined;
  wallets = [];
  bulkPut.mockReset();
  fetchCoinSeries.mockReset();
  readNativeBalances.mockReset();
  resolveBlocks.mockReset();
});

describe('reprocessWalletScope', () => {
  it('reports no snapshots rather than doing work', async () => {
    wallets = [buildWallet(OWNER_A, 0)];

    expect((await reprocessWalletScope()).status).toBe('no-snapshots');
    expect(bulkPut).not.toHaveBeenCalled();
  });

  // Without this, every attributed position would be stripped and the chart flattened.
  it('refuses when no wallet is tracked at all', async () => {
    snapshots = [buildSnapshot()];

    expect((await reprocessWalletScope()).status).toBe('no-wallets');
    expect(bulkPut).not.toHaveBeenCalled();
  });

  // The steady state, and the reason the button is safe to press habitually.
  it('does nothing at all when every point already measures the tracked wallets', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        scope: { wallets: [OWNER_A], chainIds: null, includeTestnets: false },
        attributedOwners: [OWNER_A],
      }),
    ];

    const result = await reprocessWalletScope();

    expect(result.status).toBe('in-scope');
    expect(result.snapshotsExamined).toBe(1);
    expect(bulkPut).not.toHaveBeenCalled();
    expect(resolveBlocks).not.toHaveBeenCalled();
    expect(fetchCoinSeries).not.toHaveBeenCalled();
  });

  // The headline property of the whole design.
  it('removes a tracked-then-untracked wallet with no network calls at all', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        positions: [buildPosition({ amountByOwner: { [OWNER_A]: 6, [OWNER_B]: 4 } })],
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
        attributedOwners: [OWNER_A, OWNER_B],
      }),
    ];

    const result = await reprocessWalletScope();

    expect(result.status).toBe('updated');
    expect(result.snapshotsSubtracted).toBe(1);
    expect(resolveBlocks).not.toHaveBeenCalled();
    expect(readNativeBalances).not.toHaveBeenCalled();
    expect(fetchCoinSeries).not.toHaveBeenCalled();

    expect(result.isDryRun).toBe(false);

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.positions[0].amount).toBe(6);
    expect(written.totalUsd).toBe(12_000);
    expect(written.scope?.wallets).toEqual([OWNER_A]);
  });

  it('converges: a second run finds nothing left to do', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        positions: [buildPosition({ amountByOwner: { [OWNER_A]: 6, [OWNER_B]: 4 } })],
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
        attributedOwners: [OWNER_A, OWNER_B],
      }),
    ];

    await reprocessWalletScope();
    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    snapshots = [written];
    bulkPut.mockReset();

    expect((await reprocessWalletScope()).status).toBe('in-scope');
    expect(bulkPut).not.toHaveBeenCalled();
  });

  // A point that recorded something must never be turned into a point that recorded nothing.
  it('leaves a point alone rather than emptying it', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        positions: [buildPosition({ amountByOwner: { [OWNER_B]: 10 } })],
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
        attributedOwners: [OWNER_A, OWNER_B],
      }),
    ];

    const result = await reprocessWalletScope();

    expect(result.snapshotsWouldEmpty).toBe(1);
    expect(result.snapshotsSubtracted).toBe(0);
    expect(bulkPut).not.toHaveBeenCalled();
  });

  // A removal that predates attribution cannot be corrected by arithmetic, and must be reported rather
  // than silently rebuilt.
  it('reports an unattributed removal instead of rebuilding behind the user', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
      }),
    ];

    const result = await reprocessWalletScope();

    expect(result.status).toBe('needs-rebuild');
    expect(result.snapshotsWithUnattributedRemovals).toBe(1);
    expect(result.snapshotsRebuilt).toBe(0);
    expect(bulkPut).not.toHaveBeenCalled();
  });

  it('rebuilds an unattributed removal only when explicitly asked', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
      }),
    ];

    const result = await reprocessWalletScope({ rebuildUnstamped: true });

    expect(result.snapshotsWithUnattributedRemovals).toBe(0);
    // Nothing replays out of the empty stubs, so the point would empty and is therefore left alone.
    expect(result.snapshotsWouldEmpty).toBe(1);
    expect(bulkPut).not.toHaveBeenCalled();
  });

  it('writes nothing on a dry run but reports the before and after', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        positions: [buildPosition({ amountByOwner: { [OWNER_A]: 6, [OWNER_B]: 4 } })],
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
        attributedOwners: [OWNER_A, OWNER_B],
      }),
    ];

    const result = await reprocessWalletScope({ dryRun: true });

    expect(bulkPut).not.toHaveBeenCalled();
    expect(result.isDryRun).toBe(true);
    expect(result.preview).toEqual([
      { timestamp: 1_000, totalUsdBefore: 20_000, totalUsdAfter: 12_000, method: 'subtract' },
    ]);
  });

  // A run takes minutes, and the History page's delete button is live throughout it.
  it('drops a snapshot deleted while the run was in flight', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        positions: [buildPosition({ amountByOwner: { [OWNER_A]: 6, [OWNER_B]: 4 } })],
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
        attributedOwners: [OWNER_A, OWNER_B],
      }),
    ];

    // Gone by the time the write goes in. Resurrecting it would undo a deliberate deletion.
    snapshotsAtWriteTime = [];

    await reprocessWalletScope();

    expect(bulkPut).not.toHaveBeenCalled();
  });

  // A sync ending mid-run, or the manual reprocess, rewrites the same row.
  it('drops a snapshot another writer has rewritten since it was read', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        positions: [buildPosition({ amountByOwner: { [OWNER_A]: 6, [OWNER_B]: 4 } })],
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
        attributedOwners: [OWNER_A, OWNER_B],
        createdAt: 1_000,
      }),
    ];

    // Rewritten by a sync ending mid-run, or by the manual reprocess. Overwriting it with a version
    // computed from the positions we read minutes ago would silently discard that write.
    snapshotsAtWriteTime = [{ ...snapshots[0], createdAt: 7_777 }];

    await reprocessWalletScope();

    expect(bulkPut).not.toHaveBeenCalled();
  });

  it('never touches an exchange or manual position', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    const exchange = buildPosition({ kind: 'exchange', priceKey: 'coin:bitcoin', valueUsd: 5_000 });
    const manual = buildPosition({ kind: 'manual', priceKey: 'manual:1', valueUsd: 1_000 });

    snapshots = [
      buildSnapshot({
        positions: [buildPosition({ amountByOwner: { [OWNER_A]: 6, [OWNER_B]: 4 } }), exchange, manual],
        totalUsd: 26_000,
        scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
        attributedOwners: [OWNER_A, OWNER_B],
      }),
    ];

    await reprocessWalletScope();

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.positions).toContainEqual(exchange);
    expect(written.positions).toContainEqual(manual);
    expect(written.totalUsd).toBe(12_000 + 5_000 + 1_000);
  });
});
