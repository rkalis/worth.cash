import type { Table } from 'dexie';
import {
  type ExportSlice,
  type ExportSummary,
  SLICE_STORES,
  validateExport,
  type WorthExport,
} from 'lib/backup/format';
import { db } from 'lib/db';
import { loadSettings, saveSettings } from 'lib/db/settings';
import type { AppSettings } from 'lib/settings/types';

export interface ParsedExportFile {
  export: WorthExport;
  summary: ExportSummary;
}

export interface ImportResult {
  // Rows written per store. Zero-row stores are omitted, so the summary lists only what changed.
  rowsWritten: Record<string, number>;
  importedSlices: ExportSlice[];
}

// Reads and validates an export file, gzipped or plain.
//
// Sniffed by the gzip magic bytes rather than by extension, since a renamed file should still open. A
// file that fails to parse or validate comes back as an error message: bad files are an expected input
// to an import screen.
export const parseExportFile = async (file: File): Promise<ParsedExportFile | { error: string }> => {
  let text: string;

  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const isGzip = head[0] === 0x1f && head[1] === 0x8b;

    if (isGzip) {
      const decompressed = file.stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(decompressed).text();
    } else {
      text = await file.text();
    }
  } catch {
    return { error: 'This file could not be read.' };
  }

  try {
    return validateExport(JSON.parse(text)) as ParsedExportFile | { error: string };
  } catch {
    return { error: 'This file does not contain valid JSON.' };
  }
};

// Applies the chosen slices to the database.
//
// Imports merge rather than replace: rows land by primary key, overwriting the same row and leaving every
// other row alone. That makes importing into a live database additive, importing the same file twice a
// no-op, and "replace everything" a deliberate two-step (clear synced data first) rather than something an
// import can do by surprise.
export const applyImport = async (parsed: WorthExport, slices: ExportSlice[]): Promise<ImportResult> => {
  const rowsWritten: Record<string, number> = {};
  const importedSlices: ExportSlice[] = [];

  const writeStores = async (stores: Record<string, unknown[]> | undefined, allowed: readonly string[]) => {
    if (!stores) return;

    // Only stores this version knows are written; anything else in the file is ignored, which is what
    // lets newer exports load into older apps minus the tables they do not have.
    const known = Object.entries(stores).filter(([store]) => allowed.includes(store));
    if (known.length === 0) return;

    const tables = known.map(([store]) => db[store as keyof typeof db] as Table);

    await db.transaction('rw', tables, async () => {
      for (const [store, rows] of known) {
        if (!Array.isArray(rows) || rows.length === 0) continue;
        await (db[store as keyof typeof db] as Table).bulkPut(rows);
        rowsWritten[store] = (rowsWritten[store] ?? 0) + rows.length;
      }
    });
  };

  if (slices.includes('data') && parsed.data) {
    await writeStores(parsed.data, SLICE_STORES.data);
    importedSlices.push('data');
  }

  if (slices.includes('settings') && parsed.settings) {
    const { app, ...stores } = parsed.settings;
    await writeStores(stores as Record<string, unknown[]>, SLICE_STORES.settings);

    // Section-wise onto what is already there, exactly as the settings UI writes: the file's sections win
    // where present, and sections it does not carry keep their current values. apiKeys is never part of
    // this slice, so importing settings cannot touch credentials.
    if (app) {
      const current = await loadSettings();
      await saveSettings({
        ...current,
        ...(app as Partial<AppSettings>),
        apiKeys: current.apiKeys,
      });
    }

    importedSlices.push('settings');
  }

  if (slices.includes('apiKeys') && parsed.apiKeys) {
    const current = await loadSettings();
    // Key-wise merge: a file carrying only an Etherscan key must not blank the CoinGecko key beside it.
    const merged = Object.fromEntries(
      Object.entries({ ...current.apiKeys, ...parsed.apiKeys }).filter(([, value]) => Boolean(value)),
    );
    await saveSettings({ ...current, apiKeys: merged });
    importedSlices.push('apiKeys');
  }

  if (slices.includes('exchangeAccounts') && parsed.exchangeAccounts) {
    await writeStores({ exchangeAccounts: parsed.exchangeAccounts }, SLICE_STORES.exchangeAccounts);
    importedSlices.push('exchangeAccounts');
  }

  return { rowsWritten, importedSlices };
};
