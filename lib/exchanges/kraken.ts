import type {
  ExchangeAssetBalance,
  ExchangeClient,
  ExchangeCredentials,
  ExchangeLedgerEntry,
} from 'lib/exchanges/types';
import { isIgnorableExchangeAsset, normaliseExchangeAsset } from 'lib/exchanges/types';
import ky from 'lib/ky';
import { SECOND } from 'lib/utils/time';

interface KrakenBalanceResponse {
  result?: Record<string, string>;
}

interface KrakenLedgersResponse {
  result?: {
    ledger?: Record<
      string,
      {
        refid?: string;
        // Kraken reports ledger times as fractional seconds since the epoch.
        time?: number;
        type?: string;
        asset?: string;
        amount?: string;
      }
    >;
    count?: number;
  };
}

const LEDGER_PAGE_SIZE = 50;
const MAX_PAGES = 100;

export class KrakenClient implements ExchangeClient {
  async fetchBalances(credentials: ExchangeCredentials): Promise<ExchangeAssetBalance[]> {
    const response = await this.request<KrakenBalanceResponse>(credentials, 'balance');

    const balancesByAsset = new Map<string, number>();

    for (const [rawAsset, rawAmount] of Object.entries(response.result ?? {})) {
      if (isIgnorableExchangeAsset(rawAsset)) continue;

      const amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      // Staked variants (for example ETH.S) normalise to the same asset as the spot holding, so they are
      // summed rather than shown as two unrelated positions.
      const asset = normaliseExchangeAsset(rawAsset);
      balancesByAsset.set(asset, (balancesByAsset.get(asset) ?? 0) + amount);
    }

    return [...balancesByAsset.entries()].map(([asset, amount]) => ({ asset, amount: String(amount) }));
  }

  async fetchLedger(credentials: ExchangeCredentials, since?: number): Promise<ExchangeLedgerEntry[]> {
    const entries: ExchangeLedgerEntry[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.request<KrakenLedgersResponse>(credentials, 'ledgers', {
        ofs: String(page * LEDGER_PAGE_SIZE),
        ...(since !== undefined ? { start: String(Math.floor(since / SECOND)) } : {}),
      }).catch(() => null);

      if (!response) break;

      const ledger = Object.entries(response.result?.ledger ?? {});
      if (ledger.length === 0) break;

      for (const [id, entry] of ledger) {
        if (!entry.asset || !entry.amount || entry.time === undefined) continue;

        entries.push({
          id,
          asset: normaliseExchangeAsset(entry.asset),
          amount: entry.amount,
          timestamp: Math.round(entry.time * SECOND),
          type: entry.type ?? 'unknown',
        });
      }

      const totalCount = response.result?.count ?? 0;
      if (entries.length >= totalCount) break;
    }

    return entries;
  }

  private async request<T>(
    credentials: ExchangeCredentials,
    operation: 'balance' | 'ledgers',
    parameters?: Record<string, string>,
  ): Promise<T> {
    return ky
      .post('/api/exchanges/kraken', {
        json: { operation, parameters },
        headers: {
          'x-kraken-api-key': credentials.apiKey,
          'x-kraken-api-secret': credentials.apiSecret,
        },
      })
      .json<T>();
  }
}
