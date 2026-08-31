import type { Table } from 'dexie';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ExportedStores,
  type ExportSlice,
  SLICE_STORES,
  STORE_BACKED_SLICES,
  type WorthExport,
} from 'lib/backup/format';
import { db } from 'lib/db';
import { loadSettings } from 'lib/db/settings';

// Builds an export of the requested slices, straight from the tables.
//
// Derived caches in the settings store (the asset map, fiat rates, coin-id maps) are deliberately not
// exported: they refetch themselves on the next sync, and carrying them would only make the file larger
// and staler.
export const buildExport = async (slices: ExportSlice[]): Promise<WorthExport> => {
  const result: WorthExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
  };

  const readStores = async (stores: readonly string[]): Promise<ExportedStores> => {
    const tables = await Promise.all(
      stores.map(async (store) => [store, await (db[store as keyof typeof db] as Table).toArray()] as const),
    );
    return Object.fromEntries(tables);
  };

  for (const slice of STORE_BACKED_SLICES) {
    if (slices.includes(slice)) {
      result[slice] = await readStores(SLICE_STORES[slice]);
    }
  }

  if (slices.includes('settings') || slices.includes('apiKeys')) {
    const { apiKeys, ...appSettings } = await loadSettings();

    if (slices.includes('settings')) {
      result.settings = { app: appSettings, ...(await readStores(SLICE_STORES.settings)) };
    }

    if (slices.includes('apiKeys')) {
      result.apiKeys = apiKeys;
    }
  }

  return result;
};

// Serialises an export to the file the user downloads: gzip-compressed JSON where the browser supports
// it, plain JSON where it does not. The importer sniffs which it got, so both open the same way.
export const serializeExport = async (exported: WorthExport): Promise<{ blob: Blob; filename: string }> => {
  const json = JSON.stringify(exported);
  const date = new Date(exported.exportedAt).toISOString().slice(0, 10);

  if (typeof CompressionStream === 'undefined') {
    return { blob: new Blob([json], { type: 'application/json' }), filename: `worth-cash-export-${date}.json` };
  }

  const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(compressed).blob();

  return { blob: new Blob([blob], { type: 'application/gzip' }), filename: `worth-cash-export-${date}.json.gz` };
};
