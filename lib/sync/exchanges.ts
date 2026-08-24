import { db } from 'lib/db';
import { exchangeBalanceKey, exchangeLedgerKey } from 'lib/db/keys';
import type { StoredExchangeAccount, StoredExchangeBalance, StoredExchangeLedgerEntry } from 'lib/db/schema';
import { CoinbaseClient } from 'lib/exchanges/coinbase';
import { KrakenClient } from 'lib/exchanges/kraken';
import type { ExchangeClient, ExchangeCredentials } from 'lib/exchanges/types';

export interface ExchangeSyncResult {
  accountId: string;
  assetCount: number;
  ledgerEntryCount: number;
}

const CLIENTS: Record<StoredExchangeAccount['exchange'], ExchangeClient> = {
  coinbase: new CoinbaseClient(),
  kraken: new KrakenClient(),
};

export const toCredentials = (account: StoredExchangeAccount): ExchangeCredentials => ({
  exchange: account.exchange,
  apiKey: account.apiKey,
  apiSecret: account.apiSecret,
  keyName: account.keyName,
});

// Reads current balances for one exchange account and, when asked, its transaction history.
//
// The ledger is only needed to reconstruct a past point, and it is far more expensive to fetch than the
// balances, so it is a separate opt-in rather than part of every refresh.
export const syncExchangeAccount = async (
  account: StoredExchangeAccount,
  options: { includeLedger?: boolean } = {},
): Promise<ExchangeSyncResult> => {
  const client = CLIENTS[account.exchange];
  const credentials = toCredentials(account);

  const balances = await client.fetchBalances(credentials);
  const updatedAt = Date.now();

  const rows: StoredExchangeBalance[] = balances.map((balance) => ({
    id: exchangeBalanceKey(account.id, balance.asset),
    accountId: account.id,
    asset: balance.asset,
    amount: balance.amount,
    updatedAt,
  }));

  // Assets that dropped to zero have to be removed, not merely left stale, or a sold position would stay in
  // the portfolio forever.
  const existingBalances = await db.exchangeBalances.where('accountId').equals(account.id).toArray();
  const currentIds = new Set(rows.map((row) => row.id));
  const staleIds = existingBalances.map((balance) => balance.id).filter((id) => !currentIds.has(id));

  await db.transaction('rw', db.exchangeBalances, async () => {
    await db.exchangeBalances.bulkDelete(staleIds);
    await db.exchangeBalances.bulkPut(rows);
  });

  let ledgerEntryCount = 0;

  if (options.includeLedger) {
    ledgerEntryCount = await syncExchangeLedger(account, client, credentials);
  }

  return { accountId: account.id, assetCount: rows.length, ledgerEntryCount };
};

const syncExchangeLedger = async (
  account: StoredExchangeAccount,
  client: ExchangeClient,
  credentials: ExchangeCredentials,
): Promise<number> => {
  // Resume from the newest entry we already have, so a repeat backfill is cheap. A small overlap is
  // deliberate: entries are keyed by their exchange id, so re-fetching one updates it rather than duplicating.
  const latestEntry = await db.exchangeLedger
    .where('[accountId+timestamp]')
    .between([account.id, 0], [account.id, Number.MAX_SAFE_INTEGER])
    .last();

  const entries = await client.fetchLedger(credentials, latestEntry?.timestamp);

  if (entries.length === 0) return 0;

  const rows: StoredExchangeLedgerEntry[] = entries.map((entry) => ({
    id: exchangeLedgerKey(account.id, entry.id),
    accountId: account.id,
    asset: entry.asset,
    amount: entry.amount,
    timestamp: entry.timestamp,
    type: entry.type,
  }));

  await db.exchangeLedger.bulkPut(rows);
  return rows.length;
};

export const syncAllExchangeAccounts = async (
  options: { includeLedger?: boolean } = {},
): Promise<ExchangeSyncResult[]> => {
  const accounts = await db.exchangeAccounts.where('enabled').equals(1).toArray();

  const results = await Promise.allSettled(accounts.map((account) => syncExchangeAccount(account, options)));

  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
};
