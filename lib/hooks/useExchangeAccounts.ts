'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import type { ExchangeKind, StoredExchangeAccount } from 'lib/db/schema';
import { useCallback } from 'react';

export interface NewExchangeAccount {
  exchange: ExchangeKind;
  label: string;
  apiKey: string;
  apiSecret: string;
  keyName?: string;
}

// Stable identity for the same reason as in useWallets.
const NO_ACCOUNTS: StoredExchangeAccount[] = [];

export const useExchangeAccounts = () => {
  const accounts = useLiveQuery(() => db.exchangeAccounts.toArray(), [], NO_ACCOUNTS);

  const addAccount = useCallback(async (account: NewExchangeAccount) => {
    if (!account.apiKey.trim() || !account.apiSecret.trim()) {
      throw new Error('Both the API key and secret are required');
    }

    await db.exchangeAccounts.put({
      id: crypto.randomUUID(),
      exchange: account.exchange,
      label: account.label.trim() || (account.exchange === 'coinbase' ? 'Coinbase' : 'Kraken'),
      apiKey: account.apiKey.trim(),
      apiSecret: account.apiSecret.trim(),
      keyName: account.keyName?.trim() || undefined,
      addedAt: Date.now(),
      enabled: 1,
    });
  }, []);

  const removeAccount = useCallback(async (id: string) => {
    // The balances and ledger belong to the account, so they go with it rather than lingering in totals.
    await db.transaction('rw', [db.exchangeAccounts, db.exchangeBalances, db.exchangeLedger], async () => {
      await db.exchangeAccounts.delete(id);
      await db.exchangeBalances.where('accountId').equals(id).delete();
      await db.exchangeLedger.where('accountId').equals(id).delete();
    });
  }, []);

  const setAccountEnabled = useCallback(async (id: string, enabled: boolean) => {
    await db.exchangeAccounts.update(id, { enabled: enabled ? 1 : 0 });
  }, []);

  return { accounts, addAccount, removeAccount, setAccountEnabled };
};
