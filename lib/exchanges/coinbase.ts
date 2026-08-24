import type {
  ExchangeAssetBalance,
  ExchangeClient,
  ExchangeCredentials,
  ExchangeLedgerEntry,
} from 'lib/exchanges/types';
import { normaliseExchangeAsset } from 'lib/exchanges/types';
import ky from 'lib/ky';

interface BrokerageAccountsResponse {
  accounts?: Array<{
    uuid: string;
    name?: string;
    currency: string;
    available_balance?: { value?: string; currency?: string };
    hold?: { value?: string; currency?: string };
  }>;
  has_next?: boolean;
  cursor?: string;
}

interface V2AccountsResponse {
  data?: Array<{ id: string; currency?: { code?: string } | string }>;
  pagination?: { next_starting_after?: string | null };
}

interface V2TransactionsResponse {
  data?: Array<{
    id: string;
    type?: string;
    amount?: { amount?: string; currency?: string };
    created_at?: string;
  }>;
  pagination?: { next_starting_after?: string | null };
}

const ACCOUNTS_PAGE_SIZE = 250;
const TRANSACTIONS_PAGE_SIZE = 100;

// Guards against an unexpected pagination loop turning into an unbounded request storm.
const MAX_PAGES = 50;

export class CoinbaseClient implements ExchangeClient {
  async fetchBalances(credentials: ExchangeCredentials): Promise<ExchangeAssetBalance[]> {
    const balancesByAsset = new Map<string, number>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.request<BrokerageAccountsResponse>(credentials, 'accounts', {
        query: { limit: String(ACCOUNTS_PAGE_SIZE), ...(cursor ? { cursor } : {}) },
      });

      for (const account of response.accounts ?? []) {
        // An asset's total is the spendable balance plus anything on hold; both are still owned.
        const available = Number(account.available_balance?.value ?? '0');
        const hold = Number(account.hold?.value ?? '0');
        const total = (Number.isFinite(available) ? available : 0) + (Number.isFinite(hold) ? hold : 0);

        if (total <= 0) continue;

        // Coinbase exposes several accounts per currency (spot, vault), so they are summed per asset.
        const asset = normaliseExchangeAsset(account.currency);
        balancesByAsset.set(asset, (balancesByAsset.get(asset) ?? 0) + total);
      }

      if (!response.has_next || !response.cursor) break;
      cursor = response.cursor;
    }

    return [...balancesByAsset.entries()].map(([asset, amount]) => ({ asset, amount: String(amount) }));
  }

  // Coinbase's v3 brokerage API has no ledger endpoint, so history comes from the v2 per-account
  // transaction lists. The same CDP key authenticates both.
  async fetchLedger(credentials: ExchangeCredentials, since?: number): Promise<ExchangeLedgerEntry[]> {
    const accounts = await this.fetchV2Accounts(credentials);
    const entries: ExchangeLedgerEntry[] = [];

    for (const account of accounts) {
      let startingAfter: string | undefined;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await this.request<V2TransactionsResponse>(credentials, 'v2Transactions', {
          accountId: account.id,
          query: { limit: String(TRANSACTIONS_PAGE_SIZE), ...(startingAfter ? { starting_after: startingAfter } : {}) },
        }).catch(() => null);

        // A single account failing (for example one the key cannot read) should not lose the others.
        if (!response) break;

        const transactions = response.data ?? [];
        let reachedCutoff = false;

        for (const transaction of transactions) {
          const timestamp = transaction.created_at ? Date.parse(transaction.created_at) : Number.NaN;
          if (!Number.isFinite(timestamp)) continue;

          // Transactions come newest first, so the first one older than the cutoff ends this account.
          if (since !== undefined && timestamp < since) {
            reachedCutoff = true;
            break;
          }

          const amount = transaction.amount?.amount;
          const currency = transaction.amount?.currency;
          if (!amount || !currency) continue;

          entries.push({
            id: transaction.id,
            asset: normaliseExchangeAsset(currency),
            amount,
            timestamp,
            type: transaction.type ?? 'unknown',
          });
        }

        if (reachedCutoff) break;

        const nextCursor = response.pagination?.next_starting_after;
        if (!nextCursor || transactions.length === 0) break;
        startingAfter = nextCursor;
      }
    }

    return entries;
  }

  private async fetchV2Accounts(credentials: ExchangeCredentials): Promise<Array<{ id: string }>> {
    const accounts: Array<{ id: string }> = [];
    let startingAfter: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.request<V2AccountsResponse>(credentials, 'v2Accounts', {
        query: { limit: String(ACCOUNTS_PAGE_SIZE), ...(startingAfter ? { starting_after: startingAfter } : {}) },
      }).catch(() => null);

      if (!response) break;

      accounts.push(...(response.data ?? []).map((account) => ({ id: account.id })));

      const nextCursor = response.pagination?.next_starting_after;
      if (!nextCursor) break;
      startingAfter = nextCursor;
    }

    return accounts;
  }

  private async request<T>(
    credentials: ExchangeCredentials,
    operation: 'accounts' | 'v2Accounts' | 'v2Transactions',
    options: { accountId?: string; query?: Record<string, string> } = {},
  ): Promise<T> {
    return ky
      .post('/api/exchanges/coinbase', {
        json: { operation, ...options },
        headers: {
          // The key name identifies which CDP key to sign with; the private key never leaves this request.
          'x-coinbase-key-name': credentials.keyName ?? credentials.apiKey,
          'x-coinbase-private-key': credentials.apiSecret,
        },
      })
      .json<T>();
  }
}
