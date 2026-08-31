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

// Version 2 re-cut the slices, so a version 1 file's tables no longer land where its slice names say they
// do. Files are refused across that boundary rather than silently importing part of themselves.
export const EXPORT_VERSION = 2;

// The slices, in the order they are listed to the user.
export const EXPORT_SLICES = ['records', 'snapshots', 'synced', 'settings', 'apiKeys', 'exchangeAccounts'] as const;

export type ExportSlice = (typeof EXPORT_SLICES)[number];

// Which stores each slice carries. This is the single definition both sides use, so export and import
// cannot disagree about what a slice means.
//
// The split follows what can be rebuilt rather than what the tables look like, because that is the choice
// a person is actually making when they tick a box:
//   - `records` is what only you have: the wallets you track and the manual balances and ledger entries you
//     typed. Nothing can recreate these, and they are a handful of rows.
//   - `snapshots` is the recorded history behind the value chart. Past points can be approximately
//     reconstructed, but a point recorded at sync time is exact in a way a rebuild never is, so it counts as
//     irreplaceable too. Still small: one row per point.
//   - `synced` is everything the app fetched and can fetch again: transfer logs, balances, token and NFT
//     metadata, prices, block markers, exchange balances and their ledger. This is the bulk of a file by a
//     wide margin (the transfer log alone runs to hundreds of thousands of rows on an active wallet), and
//     leaving it out costs one resync rather than any information.
//   - `settings` is how the portfolio is looked at: preferences, categories and per-token decisions.
//   - `apiKeys` and `exchangeAccounts` are credentials, split out so that a file meant for sharing or for
//     moving machines does not carry secrets unless that was the point.
export const SLICE_STORES = {
  records: ['wallets', 'manualBalances', 'manualLedger'],
  snapshots: ['snapshots'],
  synced: [
    'transferEvents',
    'syncCursors',
    'tokens',
    'balances',
    'nftCollections',
    'nftItems',
    'prices',
    'historicalPrices',
    'blockMarkers',
    'exchangeBalances',
    'exchangeLedger',
  ],
  settings: ['assetCategories', 'categoryAssignments', 'tokenOverrides'],
  apiKeys: [],
  exchangeAccounts: ['exchangeAccounts'],
} as const satisfies Record<ExportSlice, readonly string[]>;

// The slices whose payload is plainly a map of store name to rows. `settings` carries app preferences
// beside its stores and `apiKeys` is not table-backed at all, so those two are handled on their own.
export const STORE_BACKED_SLICES = ['records', 'snapshots', 'synced', 'exchangeAccounts'] as const;

export type StoreBackedSlice = (typeof STORE_BACKED_SLICES)[number];

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

export type ExportedStores = Record<string, unknown[]>;

export interface WorthExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: number;
  records?: ExportedStores;
  snapshots?: ExportedStores;
  synced?: ExportedStores;
  settings?: { app?: ExportedAppSettings } & Record<string, unknown>;
  apiKeys?: ProviderApiKeys;
  exchangeAccounts?: ExportedStores;
}

export interface ExportSummary {
  exportedAt: number;
  slices: ExportSlice[];
  // Row counts per store, for showing what a file holds before it is imported.
  storeCounts: Record<string, number>;
}

// The stores a slice carries in a given file, or undefined when the file does not carry that slice at all.
// Told apart from an empty map on purpose: one means "not exported", the other means "exported, held
// nothing".
const storesForSlice = (candidate: Partial<WorthExport>, slice: ExportSlice): Record<string, unknown> | undefined => {
  if (slice === 'apiKeys') return undefined;

  if (slice === 'settings') {
    if (candidate.settings === undefined) return undefined;
    const { app: _app, ...stores } = candidate.settings;
    return stores;
  }

  return candidate[slice];
};

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

  if (typeof candidate.version !== 'number') {
    return { error: 'This file does not contain an export.' };
  }

  if (candidate.version > EXPORT_VERSION) {
    return { error: 'This export was made by a newer version of the app. Update first, then import it.' };
  }

  if (candidate.version < EXPORT_VERSION) {
    return { error: 'This export uses an older file format that can no longer be imported.' };
  }

  const storeCounts: Record<string, number> = {};
  const slices: ExportSlice[] = [];

  for (const slice of EXPORT_SLICES) {
    if (slice === 'apiKeys') {
      if (candidate.apiKeys !== undefined) slices.push('apiKeys');
      continue;
    }

    const stores = storesForSlice(candidate, slice);
    if (stores === undefined) continue;
    slices.push(slice);

    for (const [store, rows] of Object.entries(stores)) {
      const primaryKey = STORE_PRIMARY_KEYS[store];
      // A store this version does not know is skipped rather than refused, so files travel forward.
      if (!primaryKey || !Array.isArray(rows)) continue;

      const broken = rows.findIndex(
        (row) => typeof row !== 'object' || row === null || (row as Record<string, unknown>)[primaryKey] === undefined,
      );
      if (broken !== -1) {
        return { error: `The file's ${store} table has a row without its ${primaryKey}, so it cannot be imported.` };
      }

      storeCounts[store] = rows.length;
    }
  }

  if (slices.length === 0) {
    return { error: 'This export contains nothing to import.' };
  }

  return {
    export: candidate as WorthExport,
    summary: { exportedAt: candidate.exportedAt ?? 0, slices, storeCounts },
  };
};
