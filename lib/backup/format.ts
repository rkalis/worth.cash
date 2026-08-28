import type { ProviderApiKeys } from 'lib/settings/types';

// The export file format.
//
// A single JSON envelope, usually gzip-compressed on disk. JSON because everything the app stores is
// already JSON-safe by its own conventions: bigints are stored as decimal strings, addresses as lowercase
// strings, moments as millisecond numbers, so the file is exactly the database with none of it re-encoded.
// One file rather than one per slice, because a backup you can lose half of is not a backup.
//
// Each slice is one optional top-level key, and its presence is what says it was included: an importer
// never has to guess whether an empty array means "exported nothing" or "not exported".
export const EXPORT_FORMAT = 'worth.cash/export';

// Bumped only when the envelope's shape changes in a way an older importer would misread. Adding a table
// to a slice is not that: unknown stores are ignored on import, so old files load in new apps and new
// files load in old ones minus the tables they do not know.
export const EXPORT_VERSION = 1;

export type ExportSlice = 'data' | 'settings' | 'apiKeys' | 'exchangeAccounts';

// Which stores each slice carries. This is the single definition both sides use, so export and import
// cannot disagree about what a slice means.
//
// The split follows sensitivity and purpose rather than table layout:
//   - `data` is everything the portfolio is made of: what is tracked, what was found, and what the user
//     recorded by hand. With it alone, an import renders the full portfolio without a resync.
//   - `settings` is how the portfolio is looked at: preferences, categories and per-token decisions.
//   - `apiKeys` and `exchangeAccounts` are credentials, split out so that a file meant for sharing or for
//     moving machines does not carry secrets unless that was the point.
export const SLICE_STORES = {
  data: [
    'wallets',
    'transferEvents',
    'syncCursors',
    'tokens',
    'balances',
    'nftCollections',
    'nftItems',
    'prices',
    'historicalPrices',
    'blockMarkers',
    'snapshots',
    'exchangeBalances',
    'exchangeLedger',
    'manualBalances',
    'manualLedger',
  ],
  settings: ['assetCategories', 'categoryAssignments', 'tokenOverrides'],
  apiKeys: [],
  exchangeAccounts: ['exchangeAccounts'],
} as const satisfies Record<ExportSlice, readonly string[]>;

// The primary key of every exportable store, used to sanity-check imported rows: a row without its key
// would be silently unaddressable once written, which is worse than refusing the file.
export const STORE_PRIMARY_KEYS: Record<string, string> = {
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

// The app-settings portions the settings slice carries. apiKeys is deliberately absent: it travels in its
// own slice or not at all.
export interface ExportedAppSettings {
  coingeckoTier?: unknown;
  rpcOverrides?: unknown;
  sync?: unknown;
  spam?: unknown;
  display?: unknown;
}

export interface WorthExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: number;
  data?: Record<string, unknown[]>;
  settings?: { app?: ExportedAppSettings } & Record<string, unknown>;
  apiKeys?: ProviderApiKeys;
  exchangeAccounts?: unknown[];
}

export interface ExportSummary {
  exportedAt: number;
  slices: ExportSlice[];
  // Row counts per store, for showing what a file holds before it is imported.
  storeCounts: Record<string, number>;
}

// Checks the envelope and every row's addressability, and reports what the file contains.
//
// Returns an error message rather than throwing, because a malformed file is an expected input to an
// import screen, not an exceptional one.
export const validateExport = (
  parsed: unknown,
): { export: WorthExport; summary: ExportSummary } | { error: string } => {
  if (typeof parsed !== 'object' || parsed === null) {
    return { error: 'This file does not contain an export.' };
  }

  const candidate = parsed as Partial<WorthExport>;

  if (candidate.format !== EXPORT_FORMAT) {
    return { error: 'This file is not a Worth.cash export.' };
  }

  if (typeof candidate.version !== 'number' || candidate.version > EXPORT_VERSION) {
    return { error: 'This export was made by a newer version of the app. Update first, then import it.' };
  }

  const storeCounts: Record<string, number> = {};
  const slices: ExportSlice[] = [];

  const collectStores = (slice: ExportSlice, stores: Record<string, unknown> | undefined): string | undefined => {
    if (stores === undefined) return undefined;
    slices.push(slice);

    for (const [store, rows] of Object.entries(stores)) {
      const primaryKey = STORE_PRIMARY_KEYS[store];
      // A store this version does not know is skipped rather than refused, so files travel forward.
      if (!primaryKey || !Array.isArray(rows)) continue;

      const broken = rows.findIndex(
        (row) => typeof row !== 'object' || row === null || (row as Record<string, unknown>)[primaryKey] === undefined,
      );
      if (broken !== -1) {
        return `The file's ${store} table has a row without its ${primaryKey}, so it cannot be imported.`;
      }

      storeCounts[store] = rows.length;
    }

    return undefined;
  };

  const dataError = collectStores('data', candidate.data);
  if (dataError) return { error: dataError };

  if (candidate.settings !== undefined) {
    const { app: _app, ...settingsStores } = candidate.settings;
    const settingsError = collectStores('settings', settingsStores as Record<string, unknown>);
    if (settingsError) return { error: settingsError };
  }

  if (candidate.apiKeys !== undefined) slices.push('apiKeys');

  const accountsError = collectStores(
    'exchangeAccounts',
    candidate.exchangeAccounts === undefined ? undefined : { exchangeAccounts: candidate.exchangeAccounts },
  );
  if (accountsError) return { error: accountsError };

  if (slices.length === 0) {
    return { error: 'This export contains nothing to import.' };
  }

  return {
    export: candidate as WorthExport,
    summary: { exportedAt: candidate.exportedAt ?? 0, slices, storeCounts },
  };
};
