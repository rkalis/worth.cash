import type { StoredSnapshot, StoredWallet } from 'lib/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WETH = '0x00000000000000000000000000000000000000e1';

let snapshots: StoredSnapshot[] = [];
// What the table holds by the time the write goes in, when that differs from what the run read.
let snapshotsAtWriteTime: StoredSnapshot[] | undefined;
let wallets: StoredWallet[] = [];
const bulkPut = vi.fn();
const fetchCoinSeries = vi.fn();
const readNativeBalances = vi.fn();
const resolveBlocks = vi.fn();

// Only the tables are stubbed; the real classification, row arithmetic and total assembly run.
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
    tokenOverrides: { toArray: async () => [] },
    categoryAssignments: { toArray: async () => [] },
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

vi.mock('lib/prices/historical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lib/prices/historical')>()),
  fetchHistoricalSeriesForCoin: (...args: unknown[]) => fetchCoinSeries(...args) ?? Promise.resolve(undefined),
  fetchHistoricalSeriesForContract: async () => undefined,
}));

const { reprocessWalletScope } = await import('lib/history/rescope');

const buildWallet = (address: string, addedAt: number): StoredWallet => ({ address, addedAt, enabled: 1 });

// Ten WETH at $2,000, six of them wallet A's and four wallet B's.
const buildSnapshot = (overrides: Partial<StoredSnapshot> = {}): StoredSnapshot => ({
  timestamp: 1_000,
  totalUsd: 20_000,
  createdAt: 1_000,
  balances: [
    { chainId: 1, owner: OWNER_A, token: WETH, amount: '6000000000000000000' },
    { chainId: 1, owner: OWNER_B, token: WETH, amount: '4000000000000000000' },
  ],
  tokens: [{ id: `1:${WETH}`, chainId: 1, address: WETH, symbol: 'WETH', decimals: 18, coingeckoId: 'weth' }],
  prices: [{ id: 'coingecko:weth', priceUsd: 2_000 }],
  nftCollections: [],
  nftHoldings: [],
  exchangeBalances: [],
  exchangeAccounts: [],
  exchangeAssetCoingeckoIds: {},
  manualHoldings: [],
  scope: { wallets: [OWNER_A, OWNER_B], chainIds: null, includeTestnets: false },
  attributedOwners: [OWNER_A, OWNER_B],
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

  it('refuses when no wallet is tracked at all', async () => {
    snapshots = [buildSnapshot()];

    expect((await reprocessWalletScope()).status).toBe('no-wallets');
    expect(bulkPut).not.toHaveBeenCalled();
  });

  // The steady state, and the reason the button is safe to press habitually.
  it('does nothing at all when every point already measures the tracked wallets', async () => {
    wallets = [buildWallet(OWNER_A, 0), buildWallet(OWNER_B, 0)];
    snapshots = [buildSnapshot()];

    const result = await reprocessWalletScope();

    expect(result.status).toBe('in-scope');
    expect(bulkPut).not.toHaveBeenCalled();
    expect(resolveBlocks).not.toHaveBeenCalled();
    expect(fetchCoinSeries).not.toHaveBeenCalled();
  });

  // The headline property: rows carry their owners, so removal is dropping rows, at zero network cost.
  it('removes a tracked-then-untracked wallet by dropping its rows, with no network calls', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [buildSnapshot()];

    const result = await reprocessWalletScope();

    expect(result.status).toBe('updated');
    expect(result.snapshotsSubtracted).toBe(1);
    expect(resolveBlocks).not.toHaveBeenCalled();
    expect(readNativeBalances).not.toHaveBeenCalled();
    expect(fetchCoinSeries).not.toHaveBeenCalled();

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.balances).toEqual([{ chainId: 1, owner: OWNER_A, token: WETH, amount: '6000000000000000000' }]);
    // Rendered through the same aggregation the pinned view uses: 6 WETH at the recorded $2,000.
    expect(written.totalUsd).toBe(12_000);
    expect(written.scope?.wallets).toEqual([OWNER_A]);
    expect(written.attributedOwners).toEqual([OWNER_A]);
  });

  it('converges: a second run finds nothing left to do', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [buildSnapshot()];

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
        balances: [{ chainId: 1, owner: OWNER_B, token: WETH, amount: '4000000000000000000' }],
      }),
    ];

    const result = await reprocessWalletScope();

    expect(result.snapshotsWouldEmpty).toBe(1);
    expect(result.snapshotsSubtracted).toBe(0);
    expect(bulkPut).not.toHaveBeenCalled();
  });

  // Reconstructed rows carry no owner, so a removal predating attribution cannot be arithmetic; it is
  // reported, never silently rebuilt.
  it('reports an unattributed removal instead of rebuilding behind the user', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        balances: [{ chainId: 1, owner: '', token: WETH, amount: '10000000000000000000' }],
        attributedOwners: undefined,
      }),
    ];

    const result = await reprocessWalletScope();

    expect(result.status).toBe('needs-rebuild');
    expect(result.snapshotsWithUnattributedRemovals).toBe(1);
    expect(bulkPut).not.toHaveBeenCalled();
  });

  it('prunes metadata and prices nothing references after a subtraction', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    const OTHER = '0x00000000000000000000000000000000000000f2';
    snapshots = [
      buildSnapshot({
        balances: [
          { chainId: 1, owner: OWNER_A, token: WETH, amount: '6000000000000000000' },
          { chainId: 1, owner: OWNER_B, token: OTHER, amount: '5000000' },
        ],
        tokens: [
          { id: `1:${WETH}`, chainId: 1, address: WETH, symbol: 'WETH', decimals: 18, coingeckoId: 'weth' },
          { id: `1:${OTHER}`, chainId: 1, address: OTHER, symbol: 'OTHER', decimals: 6 },
        ],
      }),
    ];

    await reprocessWalletScope();

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.tokens.map((token) => token.symbol)).toEqual(['WETH']);
  });

  it('never touches exchange or manual rows', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [
      buildSnapshot({
        exchangeBalances: [{ accountId: 'acct', asset: 'BTC', amount: '0.5' }],
        exchangeAccounts: [{ id: 'acct', label: 'K', exchange: 'kraken' }],
        exchangeAssetCoingeckoIds: { BTC: 'bitcoin' },
        manualHoldings: [{ balanceId: 'm1', symbol: 'SOL', location: 'Solana', amount: 3, coingeckoId: 'solana' }],
        prices: [
          { id: 'coingecko:weth', priceUsd: 2_000 },
          { id: 'coingecko:bitcoin', priceUsd: 90_000 },
          { id: 'coingecko:solana', priceUsd: 100 },
        ],
      }),
    ];

    await reprocessWalletScope();

    const [written] = bulkPut.mock.calls[0][0] as StoredSnapshot[];
    expect(written.exchangeBalances).toEqual([{ accountId: 'acct', asset: 'BTC', amount: '0.5' }]);
    expect(written.manualHoldings).toEqual([
      { balanceId: 'm1', symbol: 'SOL', location: 'Solana', amount: 3, coingeckoId: 'solana' },
    ]);
    // 6 WETH + 0.5 BTC + 3 SOL under the recorded prices.
    expect(written.totalUsd).toBe(12_000 + 45_000 + 300);
  });

  it('writes nothing on a dry run but reports the before and after', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [buildSnapshot()];

    const result = await reprocessWalletScope({ dryRun: true });

    expect(bulkPut).not.toHaveBeenCalled();
    expect(result.isDryRun).toBe(true);
    expect(result.preview).toEqual([
      { timestamp: 1_000, totalUsdBefore: 20_000, totalUsdAfter: 12_000, method: 'subtract' },
    ]);
  });

  it('drops a snapshot deleted while the run was in flight', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [buildSnapshot()];
    snapshotsAtWriteTime = [];

    await reprocessWalletScope();

    expect(bulkPut).not.toHaveBeenCalled();
  });

  it('drops a snapshot another writer has rewritten since it was read', async () => {
    wallets = [buildWallet(OWNER_A, 0)];
    snapshots = [buildSnapshot()];
    snapshotsAtWriteTime = [{ ...snapshots[0], createdAt: 7_777 }];

    await reprocessWalletScope();

    expect(bulkPut).not.toHaveBeenCalled();
  });
});
