import type { ExchangeKind } from 'lib/db/schema';

export interface ExchangeCredentials {
  exchange: ExchangeKind;
  apiKey: string;
  apiSecret: string;
  // Coinbase CDP keys identify themselves by a key name of the form `organizations/{org}/apiKeys/{key}`.
  // Kraken has no equivalent and leaves this unset.
  keyName?: string;
}

export interface ExchangeAssetBalance {
  // Exchange ticker, uppercased. Kraken's legacy prefixed tickers (XXBT, ZUSD) are normalised before this.
  asset: string;
  // Human-scale decimal string rather than base units, since each exchange asset has its own precision and
  // exchanges report them this way.
  amount: string;
}

export interface ExchangeLedgerEntry {
  // Unique within the account, and used to build the stored row's primary key.
  id: string;
  asset: string;
  // Signed: negative for anything leaving the account.
  amount: string;
  timestamp: number;
  type: string;
}

export interface ExchangeClient {
  fetchBalances(credentials: ExchangeCredentials): Promise<ExchangeAssetBalance[]>;
  fetchLedger(credentials: ExchangeCredentials, since?: number): Promise<ExchangeLedgerEntry[]>;
}

// Assets an exchange reports that are not really holdings, and would otherwise show up as positions.
export const isIgnorableExchangeAsset = (asset: string): boolean => {
  const upperCaseAsset = asset.toUpperCase();
  // Kraken reports staked and earn variants with these suffixes alongside the underlying asset. They are
  // real holdings, so they are kept, but the suffix is stripped elsewhere so they aggregate correctly.
  return upperCaseAsset === '' || upperCaseAsset === 'KFEE';
};

// Kraken uses its own historical ticker prefixes: X for crypto, Z for fiat, both on four-character codes.
// The rest of the app, and CoinGecko, use the plain ticker.
export const normaliseExchangeAsset = (asset: string): string => {
  const upperCaseAsset = asset.toUpperCase();

  // Staking and yield-bearing variants are the same underlying asset for portfolio purposes.
  //
  // Kraken names bonded staking by the bonding period, so DOT28.S and ETH2.S are DOT and ETH locked for 28
  // and 2 days. The digits go with the suffix: leaving them attached produces a ticker no price source has
  // ever heard of, and the holding lands on its own unpriced row instead of merging with the spot balance.
  const withoutSuffix = upperCaseAsset.replace(/(\d*\.[SFMB]|\.HOLD|\.STAKED)$/, '');

  if (withoutSuffix.length === 4 && (withoutSuffix.startsWith('X') || withoutSuffix.startsWith('Z'))) {
    const stripped = withoutSuffix.slice(1);
    // XBT is Kraken's name for BTC.
    return stripped === 'XBT' ? 'BTC' : stripped;
  }

  return withoutSuffix === 'XBT' ? 'BTC' : withoutSuffix;
};
