'use client';

import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import InfoTooltip from 'components/ui/InfoTooltip';
import { buildExport, serializeExport } from 'lib/backup/export';
import type { ExportSlice } from 'lib/backup/format';
import { applyImport, type ImportResult, type ParsedExportFile, parseExportFile } from 'lib/backup/import';
import { formatDateTimeUtc } from 'lib/format';
import { useSyncProgress } from 'lib/sync/progress';
import { useRef, useState } from 'react';

interface SliceOption {
  slice: ExportSlice;
  label: string;
  tooltip: string;
  // On by default: everything the app cannot fetch again. Synced data is off because it is the bulk of the
  // file and costs only a resync, and credentials are off so a file made to share carries no secrets by
  // accident.
  defaultChecked: boolean;
}

const SLICE_OPTIONS: SliceOption[] = [
  {
    slice: 'records',
    label: 'Wallets and manual records',
    tooltip:
      'The wallets you track and the manual balances and ledger entries you typed. Nothing can recreate these, and they are a handful of rows.',
    defaultChecked: true,
  },
  {
    slice: 'snapshots',
    label: 'History snapshots',
    tooltip:
      'The recorded points behind the value chart. Past points can be reconstructed approximately, but one recorded at sync time is exact, so keep these.',
    defaultChecked: true,
  },
  {
    slice: 'synced',
    label: 'Synced data',
    tooltip:
      'Transfer logs, balances, token and NFT metadata, prices and exchange balances. This is nearly the whole size of a file. Leaving it out costs one resync and no information.',
    defaultChecked: false,
  },
  {
    slice: 'settings',
    label: 'Settings',
    tooltip: 'Preferences, enabled chains, spam filters, custom RPCs, categories, and per-token show/hide decisions.',
    defaultChecked: true,
  },
  {
    slice: 'apiKeys',
    label: 'API keys',
    tooltip:
      'The provider keys from the API keys section. These are credentials: leave them out of any file you might share.',
    defaultChecked: false,
  },
  {
    slice: 'exchangeAccounts',
    label: 'Exchange accounts',
    tooltip:
      'Exchange account entries including their API credentials. These are credentials: leave them out of any file you might share.',
    defaultChecked: false,
  },
];

const SLICE_LABELS = Object.fromEntries(SLICE_OPTIONS.map((option) => [option.slice, option.label])) as Record<
  ExportSlice,
  string
>;

const BackupSection = () => {
  const isSyncing = useSyncProgress((state) => state.isRunning);

  const [exportSlices, setExportSlices] = useState<Set<ExportSlice>>(
    () => new Set(SLICE_OPTIONS.filter((option) => option.defaultChecked).map((option) => option.slice)),
  );
  const [isExporting, setIsExporting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsedFile, setParsedFile] = useState<ParsedExportFile>();
  const [importSlices, setImportSlices] = useState<Set<ExportSlice>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult>();
  const [error, setError] = useState<string>();

  const toggle = (set: Set<ExportSlice>, slice: ExportSlice): Set<ExportSlice> => {
    const next = new Set(set);
    if (next.has(slice)) {
      next.delete(slice);
    } else {
      next.add(slice);
    }
    return next;
  };

  const runExport = async () => {
    setIsExporting(true);
    setError(undefined);

    try {
      const { blob, filename } = await serializeExport(await buildExport([...exportSlices]));

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setIsExporting(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    setError(undefined);
    setImportResult(undefined);
    setParsedFile(undefined);

    if (!file) return;

    const parsed = await parseExportFile(file);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }

    setParsedFile(parsed);
    // Everything the file carries starts selected: picking the file was already the choice to import it,
    // and the checkboxes exist to leave things out.
    setImportSlices(new Set(parsed.summary.slices));
  };

  const runImport = async () => {
    if (!parsedFile) return;

    setIsImporting(true);
    setError(undefined);

    try {
      setImportResult(await applyImport(parsedFile.export, [...importSlices]));
      setParsedFile(undefined);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Card
      title={
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          Export and import
          <InfoTooltip tooltip="One gzipped JSON file holding the slices you pick. Importing merges by key: matching rows are overwritten, everything else is left alone, and importing the same file twice changes nothing. To replace instead of merge, clear the local data first." />
        </h2>
      }
      bodyClassName="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {SLICE_OPTIONS.map((option) => (
            <label key={option.slice} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={exportSlices.has(option.slice)}
                onChange={() => setExportSlices(toggle(exportSlices, option.slice))}
                className="size-3.5 accent-brand"
              />
              {option.label}
              <InfoTooltip tooltip={option.tooltip} />
            </label>
          ))}
        </div>

        <div>
          <Button
            variant="primary"
            size="sm"
            onClick={runExport}
            loading={isExporting}
            disabled={isExporting || exportSlices.size === 0}
          >
            Export
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-zinc-200 dark:border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.gz,application/json,application/gzip"
            aria-label="Export file to import"
            className="text-xs text-zinc-600 dark:text-zinc-400 file:mr-3 file:px-3 file:h-8 file:rounded-lg file:border file:border-zinc-300 dark:file:border-zinc-700 file:bg-transparent file:text-xs file:font-medium file:text-inherit file:cursor-pointer"
            onChange={(event) => pickFile(event.target.files?.[0])}
          />
        </div>

        {parsedFile ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Exported {formatDateTimeUtc(parsedFile.summary.exportedAt)} ·{' '}
              {Object.values(parsedFile.summary.storeCounts)
                .reduce((total, count) => total + count, 0)
                .toLocaleString('en-US')}{' '}
              rows
            </p>

            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {parsedFile.summary.slices.map((slice) => (
                <label key={slice} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                  <input
                    type="checkbox"
                    checked={importSlices.has(slice)}
                    onChange={() => setImportSlices(toggle(importSlices, slice))}
                    className="size-3.5 accent-brand"
                  />
                  {SLICE_LABELS[slice]}
                </label>
              ))}
            </div>

            <div>
              <Button
                variant="primary"
                size="sm"
                onClick={runImport}
                loading={isImporting}
                disabled={isImporting || isSyncing || importSlices.size === 0}
                title={isSyncing ? 'Wait for the running sync to finish' : undefined}
              >
                Import
              </Button>
            </div>
          </div>
        ) : null}

        {importResult ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Imported{' '}
            {Object.values(importResult.rowsWritten)
              .reduce((total, count) => total + count, 0)
              .toLocaleString('en-US')}{' '}
            rows across {importResult.importedSlices.map((slice) => SLICE_LABELS[slice].toLowerCase()).join(', ')}.
          </p>
        ) : null}

        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
    </Card>
  );
};

export default BackupSection;
