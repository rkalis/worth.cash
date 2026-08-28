'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import type { StoredManualBalance, StoredManualLedgerEntry } from 'lib/db/schema';
import { buildManualHoldings, type ManualHolding } from 'lib/manual/balances';
import { fetchCoinGeckoIdPrices } from 'lib/prices/current';
import { useCallback, useMemo } from 'react';

// Stable empty arrays. A fresh literal each render makes the live query's snapshot a new reference every
// time, which sends useSyncExternalStore into a loop.
const NO_BALANCES: StoredManualBalance[] = [];
const NO_ENTRIES: StoredManualLedgerEntry[] = [];

export interface ManualBalanceInput {
  symbol: string;
  location: string;
  wallet?: string;
  coingeckoId?: string;
}

export interface ManualLedgerInput {
  balanceId: string;
  kind: 'buy' | 'sell';
  amount: string;
  timestamp: number;
  note?: string;
}

// Prices the coin behind a manual holding straight away, rather than leaving it until the next sync.
//
// A holding with no price is not merely missing a number: the unpriced filter hides it, so a balance added
// between syncs disappeared from the portfolio entirely until one happened to run. Fire and forget, because
// the row should appear the moment it is added and the figure can catch up a beat later; a failure here is
// retried by the next sync, and is deliberately not stored as a confirmed absence of price.
const priceCoinNow = (coingeckoId?: string): void => {
  if (!coingeckoId) return;

  void fetchCoinGeckoIdPrices([coingeckoId]).catch(() => undefined);
};

export const useManualBalances = () => {
  const balances = useLiveQuery(() => db.manualBalances.toArray(), []) ?? NO_BALANCES;
  const entries = useLiveQuery(() => db.manualLedger.toArray(), []) ?? NO_ENTRIES;

  const holdings: ManualHolding[] = useMemo(() => buildManualHoldings(balances, entries), [balances, entries]);

  const entriesByBalance = useMemo(() => {
    const grouped = new Map<string, StoredManualLedgerEntry[]>();

    // Newest first, which is the order the list is read in: the most recent trade is the one being checked.
    for (const entry of [...entries].sort((a, b) => b.timestamp - a.timestamp)) {
      const existing = grouped.get(entry.balanceId);
      if (existing) {
        existing.push(entry);
      } else {
        grouped.set(entry.balanceId, [entry]);
      }
    }

    return grouped;
  }, [entries]);

  const addBalance = useCallback(async (input: ManualBalanceInput): Promise<string> => {
    const id = crypto.randomUUID();

    await db.manualBalances.put({
      id,
      symbol: input.symbol.trim().toUpperCase(),
      location: input.location.trim(),
      wallet: input.wallet?.trim() || undefined,
      coingeckoId: input.coingeckoId?.trim().toLowerCase() || undefined,
      createdAt: Date.now(),
      enabled: 1,
    });

    priceCoinNow(input.coingeckoId?.trim().toLowerCase());

    return id;
  }, []);

  const updateBalance = useCallback(async (id: string, changes: Partial<ManualBalanceInput>) => {
    // Read and write inside one transaction. An edit field's blur fires just before a click on Remove
    // lands, and with a bare get-then-put the remove's delete could run between the two, so the put would
    // resurrect the balance it had just removed, minus its ledger.
    const priceNewCoinId = await db.transaction('rw', db.manualBalances, async () => {
      const existing = await db.manualBalances.get(id);
      if (!existing) return undefined;

      const coingeckoId =
        changes.coingeckoId === undefined
          ? existing.coingeckoId
          : changes.coingeckoId.trim().toLowerCase() || undefined;

      await db.manualBalances.put({
        ...existing,
        ...(changes.symbol === undefined ? {} : { symbol: changes.symbol.trim().toUpperCase() }),
        ...(changes.location === undefined ? {} : { location: changes.location.trim() }),
        ...(changes.wallet === undefined ? {} : { wallet: changes.wallet.trim() || undefined }),
        coingeckoId,
      });

      return coingeckoId !== existing.coingeckoId ? coingeckoId : undefined;
    });

    // Only when the price source actually changed: correcting a typo should show a price immediately rather
    // than after the next sync. Outside the transaction, since a fetch has no place inside one.
    if (priceNewCoinId !== undefined) priceCoinNow(priceNewCoinId);
  }, []);

  const setBalanceEnabled = useCallback(async (id: string, enabled: boolean) => {
    const existing = await db.manualBalances.get(id);
    if (!existing) return;

    await db.manualBalances.put({ ...existing, enabled: enabled ? 1 : 0 });
  }, []);

  // Removing a balance takes its ledger with it. Entries that referred to nothing would be invisible in
  // the UI while still being replayed by a reconstruction, which would put a holding on the chart that the
  // portfolio says does not exist.
  const removeBalance = useCallback(async (id: string) => {
    await db.transaction('rw', db.manualBalances, db.manualLedger, async () => {
      await db.manualLedger.where('balanceId').equals(id).delete();
      await db.manualBalances.delete(id);
    });
  }, []);

  const addEntry = useCallback(async (input: ManualLedgerInput) => {
    await db.manualLedger.put({
      id: crypto.randomUUID(),
      balanceId: input.balanceId,
      kind: input.kind,
      amount: input.amount,
      timestamp: input.timestamp,
      note: input.note?.trim() || undefined,
    });
  }, []);

  const updateEntry = useCallback(async (id: string, changes: Omit<ManualLedgerInput, 'balanceId'>) => {
    const existing = await db.manualLedger.get(id);
    if (!existing) return;

    // The balance an entry belongs to is deliberately not editable: moving a trade between ledgers is two
    // decisions disguised as one, and deleting plus re-adding says both of them explicitly. A field the
    // caller did not pass keeps its stored value, the same rule updateBalance follows, so an editor that
    // has no notion of notes cannot erase one.
    await db.manualLedger.put({
      ...existing,
      kind: changes.kind,
      amount: changes.amount,
      timestamp: changes.timestamp,
      ...(changes.note === undefined ? {} : { note: changes.note.trim() || undefined }),
    });
  }, []);

  const removeEntry = useCallback(async (id: string) => {
    await db.manualLedger.delete(id);
  }, []);

  return {
    balances,
    holdings,
    entriesByBalance,
    addBalance,
    updateBalance,
    setBalanceEnabled,
    removeBalance,
    addEntry,
    updateEntry,
    removeEntry,
    isLoading: balances === NO_BALANCES && entries === NO_ENTRIES,
  };
};
