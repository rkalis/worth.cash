import type { Table } from 'dexie';
import { EXPORT_FORMAT, EXPORT_VERSION, validateExport } from 'lib/backup/format';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tables = new Map<string, Map<unknown, Record<string, unknown>>>();
let storedSettings: Record<string, unknown> | undefined;

// Shaped like the two Table methods the backup code calls; Dexie's PromiseExtended return types make a
// faithful Partial<Table> more ceremony than the fake is worth.
const tableFor = (store: string, primaryKey: string) =>
  ({
    toArray: async () => [...(tables.get(store)?.values() ?? [])],
    bulkPut: async (rows: Record<string, unknown>[]) => {
      const table = tables.get(store) ?? new Map();
      for (const row of rows) table.set(row[primaryKey], row);
      tables.set(store, table);
    },
  }) as unknown as Table;

vi.mock('lib/db', () => {
  const stores: Record<string, string> = {
    wallets: 'address',
    transferEvents: 'id',
    syncCursors: 'id',
    tokens: 'id',
    balances: 'id',
    nftCollections: 'id',
    nftItems: 'id',
    prices: 'id',
    historicalPrices: 'id',
    blockMarkers: 'id',
    snapshots: 'timestamp',
    exchangeBalances: 'id',
    exchangeLedger: 'id',
    manualBalances: 'id',
    manualLedger: 'id',
    assetCategories: 'id',
    categoryAssignments: 'id',
    tokenOverrides: 'id',
    exchangeAccounts: 'id',
  };

  const db: Record<string, unknown> = {
    settings: {
      get: async () => (storedSettings ? { key: 'app-settings', value: storedSettings } : undefined),
      put: async (row: { value: Record<string, unknown> }) => {
        storedSettings = row.value;
      },
    },
    transaction: async (_mode: string, _tables: unknown, run: () => Promise<void>) => run(),
  };
  for (const [store, primaryKey] of Object.entries(stores)) {
    db[store] = tableFor(store, primaryKey);
  }

  return { db };
});

const { buildExport, serializeExport } = await import('lib/backup/export');
const { applyImport, parseExportFile } = await import('lib/backup/import');

const seed = (store: string, primaryKey: string, rows: Record<string, unknown>[]) => {
  tables.set(store, new Map(rows.map((row) => [row[primaryKey], row])));
};

// A database holding one of everything the slices divide up.
const seedEverything = () => {
  seed('wallets', 'address', [{ address: '0xaaa', enabled: 1, addedAt: 1 }]);
  seed('manualBalances', 'id', [{ id: 'm1', symbol: 'BTC', location: 'Bitcoin', enabled: 1, createdAt: 0 }]);
  seed('manualLedger', 'id', [{ id: 'e1', balanceId: 'm1', kind: 'buy', amount: '0.5', timestamp: 1 }]);
  seed('snapshots', 'timestamp', [{ timestamp: 100, totalUsd: 5, createdAt: 1, balances: [] }]);
  seed('transferEvents', 'id', [{ id: 't1', chainId: 1, owner: '0xaaa', token: '0xbbb', blockNumber: 1 }]);
  seed('balances', 'id', [{ id: 'b1', chainId: 1, owner: '0xaaa', token: '0xbbb', amount: '1' }]);
  seed('assetCategories', 'id', [{ id: 'c1', name: 'Blue Chip', sortIndex: 0, createdAt: 0 }]);
  seed('exchangeAccounts', 'id', [{ id: 'acct', exchange: 'kraken', label: 'K', enabled: 1 }]);
};

beforeEach(() => {
  tables.clear();
  storedSettings = {
    apiKeys: { coingecko: 'cg-key', etherscan: 'es-key' },
    coingeckoTier: 'auto',
    rpcOverrides: {},
    sync: {
      enabledChainIds: null,
      includeTestnets: false,
      chainConcurrency: 4,
      refreshIntervalMinutes: 30,
      skipInactiveChains: true,
    },
    spam: { dustThresholdUsd: 1, dustThresholdAmount: 0.000001, hideUnpricedTokens: true, useSpamHeuristics: true },
    display: { currency: 'eur', hideBalances: false },
  };
});

describe('the export envelope', () => {
  it('refuses a file that is not an export', () => {
    expect(validateExport({ some: 'json' })).toHaveProperty('error');
    expect(validateExport('worth.cash/export')).toHaveProperty('error');
  });

  it('refuses a file from a newer version, with advice rather than a crash', () => {
    const result = validateExport({ format: EXPORT_FORMAT, version: EXPORT_VERSION + 1, exportedAt: 0 });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('newer version');
  });

  // Version 1 named its slices differently, so importing one would land part of it and silently drop the
  // rest. Refusing says so instead.
  it('refuses a file from the older format rather than importing part of it', () => {
    const result = validateExport({
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: 0,
      data: { wallets: [{ address: '0xa' }] },
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('older file format');
  });

  it('refuses a row that would be unaddressable once written', () => {
    const result = validateExport({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: 0,
      records: { wallets: [{ label: 'no address field' }] },
    });
    expect((result as { error: string }).error).toContain('wallets');
  });

  it('reports which slices a file carries and how many rows', () => {
    const result = validateExport({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: 5,
      records: { wallets: [{ address: '0xa' }] },
      snapshots: { snapshots: [{ timestamp: 1 }, { timestamp: 2 }] },
      apiKeys: { coingecko: 'x' },
    });

    expect(result).toMatchObject({
      summary: { slices: ['records', 'snapshots', 'apiKeys'], storeCounts: { wallets: 1, snapshots: 2 } },
    });
  });
});

describe('export and import round trip', () => {
  it('carries every selected slice through the gzipped file and back', async () => {
    seedEverything();

    const exported = await buildExport(['records', 'snapshots', 'synced', 'settings', 'apiKeys', 'exchangeAccounts']);
    const { blob, filename } = await serializeExport(exported);
    expect(filename.endsWith('.json.gz')).toBe(true);

    // A fresh database on the importing side.
    tables.clear();
    storedSettings = undefined;

    const file = new File([blob], filename);
    const parsed = await parseExportFile(file);
    expect(parsed).not.toHaveProperty('error');
    if ('error' in parsed) throw new Error(parsed.error);

    const result = await applyImport(parsed.export, parsed.summary.slices);

    expect(result.rowsWritten).toMatchObject({
      wallets: 1,
      manualBalances: 1,
      manualLedger: 1,
      snapshots: 1,
      transferEvents: 1,
      assetCategories: 1,
      exchangeAccounts: 1,
    });
    expect(tables.get('wallets')?.get('0xaaa')).toMatchObject({ address: '0xaaa' });
    expect(tables.get('snapshots')?.get(100)).toMatchObject({ totalUsd: 5 });
    expect(storedSettings).toMatchObject({
      display: { currency: 'eur' },
      apiKeys: { coingecko: 'cg-key', etherscan: 'es-key' },
    });
  });

  // The reason the slices are cut this way: the default file holds what cannot be fetched again, and the
  // transfer log, which is nearly all of the bytes, is not in it.
  it('leaves the synced tables out of a file that did not ask for them', async () => {
    seedEverything();

    const exported = await buildExport(['records', 'snapshots', 'settings']);

    expect(exported.synced).toBeUndefined();
    expect(JSON.stringify(exported)).not.toContain('transferEvents');
    expect(exported.records?.wallets).toHaveLength(1);
    expect(exported.records?.manualLedger).toHaveLength(1);
    expect(exported.snapshots?.snapshots).toHaveLength(1);
  });

  it('restores the wallets and manual records without the synced tables', async () => {
    seedEverything();
    const exported = await buildExport(['records', 'snapshots']);

    tables.clear();
    const result = await applyImport(exported, ['records', 'snapshots']);

    expect(result.importedSlices).toEqual(['records', 'snapshots']);
    expect(result.rowsWritten).toEqual({ wallets: 1, manualBalances: 1, manualLedger: 1, snapshots: 1 });
    expect(tables.has('transferEvents')).toBe(false);
  });

  it('imports history on its own, leaving the wallets in the file alone', async () => {
    seedEverything();
    const exported = await buildExport(['records', 'snapshots']);

    tables.clear();
    const result = await applyImport(exported, ['snapshots']);

    expect(result.rowsWritten).toEqual({ snapshots: 1 });
    expect(tables.has('wallets')).toBe(false);
  });

  it('opens a plain uncompressed file the same way', async () => {
    seed('wallets', 'address', [{ address: '0xbbb', enabled: 1, addedAt: 1 }]);
    const exported = await buildExport(['records']);

    const file = new File([JSON.stringify(exported)], 'export.json');
    const parsed = await parseExportFile(file);

    expect(parsed).toMatchObject({ summary: { storeCounts: { wallets: 1 } } });
  });

  it('never exports API keys inside the settings slice', async () => {
    const exported = await buildExport(['settings']);

    expect(exported.settings?.app).toBeDefined();
    expect(JSON.stringify(exported.settings)).not.toContain('cg-key');
    expect(exported.apiKeys).toBeUndefined();
  });

  it('imports only the slices that were chosen, whatever the file holds', async () => {
    seed('wallets', 'address', [{ address: '0xccc', enabled: 1, addedAt: 1 }]);
    const exported = await buildExport(['records', 'apiKeys']);

    tables.clear();
    storedSettings = { apiKeys: {} };

    await applyImport(exported, ['records']);

    expect(tables.get('wallets')?.size).toBe(1);
    expect((storedSettings as { apiKeys: Record<string, string> }).apiKeys).toEqual({});
  });

  it('merges API keys key-wise rather than replacing the set', async () => {
    const exported = await buildExport(['apiKeys']);

    storedSettings = { apiKeys: { alchemy: 'existing-alchemy' } };
    await applyImport(exported, ['apiKeys']);

    expect((storedSettings as { apiKeys: Record<string, string> }).apiKeys).toMatchObject({
      alchemy: 'existing-alchemy',
      coingecko: 'cg-key',
    });
  });

  it('overlays by key and leaves unrelated rows alone', async () => {
    seed('wallets', 'address', [{ address: '0xold', label: 'kept', enabled: 1, addedAt: 1 }]);

    await applyImport(
      {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: 0,
        records: { wallets: [{ address: '0xnew', enabled: 1, addedAt: 2 }] },
      },
      ['records'],
    );

    expect(tables.get('wallets')?.size).toBe(2);
    expect(tables.get('wallets')?.get('0xold')).toMatchObject({ label: 'kept' });
  });

  it('ignores stores the app does not know, so newer files still load', async () => {
    const result = await applyImport(
      {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: 0,
        records: { wallets: [{ address: '0xa', enabled: 1, addedAt: 1 }], futureStore: [{ id: 'x' }] },
      },
      ['records'],
    );

    expect(result.rowsWritten).toEqual({ wallets: 1 });
    expect(tables.has('futureStore')).toBe(false);
  });
});
