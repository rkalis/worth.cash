'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import type { StoredWallet } from 'lib/db/schema';
import { useCallback } from 'react';
import { getAddress, isAddress } from 'viem';

// Hoisted so the pre-resolution value keeps a stable identity across renders. An inline literal here makes
// useLiveQuery hand back a new snapshot every render, which useSyncExternalStore reads as a state change.
const NO_WALLETS: StoredWallet[] = [];

export const useWallets = () => {
  const wallets = useLiveQuery(() => db.wallets.orderBy('addedAt').toArray(), [], NO_WALLETS);

  const addWallet = useCallback(async (input: string, label?: string) => {
    const trimmed = input.trim();

    if (!isAddress(trimmed)) {
      throw new Error('That is not a valid EVM address');
    }

    // Stored lowercase so that a re-add with different casing updates the same row rather than duplicating.
    const address = trimmed.toLowerCase();
    const existing = await db.wallets.get(address);

    if (existing) {
      throw new Error('That address is already being tracked');
    }

    await db.wallets.put({
      address,
      label: label?.trim() || undefined,
      addedAt: Date.now(),
      enabled: 1,
    });

    return getAddress(trimmed);
  }, []);

  const removeWallet = useCallback(async (address: string) => {
    const lowercaseAddress = address.toLowerCase();

    // Everything derived from this wallet goes with it, otherwise its balances would linger in the totals.
    await db.transaction('rw', [db.wallets, db.balances, db.transferEvents, db.syncCursors, db.nftItems], async () => {
      await db.wallets.delete(lowercaseAddress);
      await db.balances.where('owner').equals(lowercaseAddress).delete();
      await db.transferEvents.where('owner').equals(lowercaseAddress).delete();
      await db.syncCursors.where('owner').equals(lowercaseAddress).delete();
      await db.nftItems.where('owner').equals(lowercaseAddress).delete();
    });
  }, []);

  const setWalletEnabled = useCallback(async (address: string, enabled: boolean) => {
    await db.wallets.update(address.toLowerCase(), { enabled: enabled ? 1 : 0 });
  }, []);

  const setWalletLabel = useCallback(async (address: string, label: string) => {
    await db.wallets.update(address.toLowerCase(), { label: label.trim() || undefined });
  }, []);

  return { wallets, addWallet, removeWallet, setWalletEnabled, setWalletLabel };
};
