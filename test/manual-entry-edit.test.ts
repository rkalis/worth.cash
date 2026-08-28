// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledgerPut = vi.fn();
const ledgerGet = vi.fn();

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));

vi.mock('lib/db', () => ({
  db: {
    manualBalances: { toArray: async () => [], put: vi.fn(), get: vi.fn() },
    manualLedger: {
      toArray: async () => [],
      put: (row: unknown) => ledgerPut(row),
      get: (id: string) => ledgerGet(id),
    },
    transaction: async (_mode: string, _table: unknown, run: () => Promise<unknown>) => run(),
  },
}));

vi.mock('lib/prices/current', () => ({ fetchCoinGeckoIdPrices: async () => new Map() }));

const { useManualBalances } = await import('lib/hooks/useManualBalances');

describe('editing a ledger entry', () => {
  beforeEach(() => {
    ledgerPut.mockReset();
    ledgerGet.mockReset();
  });

  // The editor has no notion of notes, and editing an amount must not cost the entry one it carries.
  it('keeps a stored note the editor never touched', async () => {
    ledgerGet.mockResolvedValue({
      id: 'e-1',
      balanceId: 'b-1',
      kind: 'buy',
      amount: '0.5',
      timestamp: 1_000,
      note: 'bought on the dip',
    });

    const { result } = renderHook(() => useManualBalances());
    await result.current.updateEntry('e-1', { kind: 'buy', amount: '0.75', timestamp: 1_000 });

    expect(ledgerPut).toHaveBeenCalledWith(expect.objectContaining({ amount: '0.75', note: 'bought on the dip' }));
  });

  it('clears a note only when explicitly asked to', async () => {
    ledgerGet.mockResolvedValue({
      id: 'e-1',
      balanceId: 'b-1',
      kind: 'buy',
      amount: '0.5',
      timestamp: 1_000,
      note: 'x',
    });

    const { result } = renderHook(() => useManualBalances());
    await result.current.updateEntry('e-1', { kind: 'buy', amount: '0.5', timestamp: 1_000, note: '' });

    expect(ledgerPut).toHaveBeenCalledWith(expect.objectContaining({ note: undefined }));
  });

  it('never moves an entry to another balance', async () => {
    ledgerGet.mockResolvedValue({ id: 'e-1', balanceId: 'b-1', kind: 'buy', amount: '0.5', timestamp: 1_000 });

    const { result } = renderHook(() => useManualBalances());
    await result.current.updateEntry('e-1', { kind: 'sell', amount: '0.5', timestamp: 2_000 });

    expect(ledgerPut).toHaveBeenCalledWith(expect.objectContaining({ balanceId: 'b-1', kind: 'sell' }));
  });

  it('does nothing for an entry that no longer exists', async () => {
    ledgerGet.mockResolvedValue(undefined);

    const { result } = renderHook(() => useManualBalances());
    await result.current.updateEntry('gone', { kind: 'buy', amount: '1', timestamp: 1_000 });

    expect(ledgerPut).not.toHaveBeenCalled();
  });
});
