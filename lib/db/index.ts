import Dexie, { type Table } from 'dexie';
import type {
  StoredBalance,
  StoredBlockMarker,
  StoredExchangeAccount,
  StoredExchangeBalance,
  StoredExchangeLedgerEntry,
  StoredHistoricalPrice,
  StoredNftCollection,
  StoredNftItem,
  StoredPrice,
  StoredSetting,
  StoredSnapshot,
  StoredSyncCursor,
  StoredToken,
  StoredTokenOverride,
  StoredTransferEvent,
  StoredWallet,
} from 'lib/db/schema';

export class PortfolioDatabase extends Dexie {
  settings!: Table<StoredSetting, string>;
  wallets!: Table<StoredWallet, string>;
  exchangeAccounts!: Table<StoredExchangeAccount, string>;
  transferEvents!: Table<StoredTransferEvent, string>;
  syncCursors!: Table<StoredSyncCursor, string>;
  tokens!: Table<StoredToken, string>;
  balances!: Table<StoredBalance, string>;
  nftCollections!: Table<StoredNftCollection, string>;
  nftItems!: Table<StoredNftItem, string>;
  prices!: Table<StoredPrice, string>;
  historicalPrices!: Table<StoredHistoricalPrice, string>;
  snapshots!: Table<StoredSnapshot, number>;
  exchangeBalances!: Table<StoredExchangeBalance, string>;
  exchangeLedger!: Table<StoredExchangeLedgerEntry, string>;
  tokenOverrides!: Table<StoredTokenOverride, string>;
  blockMarkers!: Table<StoredBlockMarker, string>;

  constructor() {
    super('portfolio-tracker');

    // Only indexed fields are listed here; every other field of a row is stored but not queryable.
    this.version(1).stores({
      settings: 'key',
      wallets: 'address, enabled, addedAt',
      exchangeAccounts: 'id, exchange, enabled',

      // The compound indexes drive the two queries that matter: "every token this wallet has touched on
      // this chain" during discovery, and "this wallet's history in order" during snapshot reconstruction.
      transferEvents: 'id, [chainId+owner], [chainId+owner+token], [chainId+token], [owner+blockNumber], owner, token',

      syncCursors: 'id, [chainId+owner], chainId, owner, status',
      tokens: 'id, [chainId+address], chainId, isSpam',
      balances: 'id, [chainId+owner], [owner+token], owner, token, chainId',
      nftCollections: 'id, [chainId+address], chainId, openseaSlug',
      nftItems: 'id, [chainId+owner], [chainId+collection], [owner+collection], owner, collection',
      prices: 'id, updatedAt',
      historicalPrices: 'id, [priceKey+timestamp], priceKey, timestamp',
      snapshots: 'timestamp',
      exchangeBalances: 'id, accountId, asset',
      exchangeLedger: 'id, [accountId+timestamp], accountId, asset, timestamp',
      tokenOverrides: 'id',
      blockMarkers: 'id, [chainId+timestamp], chainId',
    });
  }
}

// Dexie opens a real IndexedDB connection on construction, which does not exist during server rendering.
// Every caller runs in the browser, but Next.js still evaluates these modules on the server, so the
// instance is created lazily on first access rather than at import time.
let database: PortfolioDatabase | undefined;

export const db = new Proxy({} as PortfolioDatabase, {
  get(_target, property) {
    if (!database) {
      if (typeof window === 'undefined') {
        throw new Error('The portfolio database is only available in the browser');
      }
      database = new PortfolioDatabase();
    }

    return Reflect.get(database, property, database);
  },
});

// Wipes every table while leaving settings and tracked accounts intact. Used by the "resync everything"
// action, where the point is to rebuild derived data without making the user re-enter their configuration.
export const clearSyncedData = async (): Promise<void> => {
  await Promise.all([
    db.transferEvents.clear(),
    db.syncCursors.clear(),
    db.tokens.clear(),
    db.balances.clear(),
    db.nftCollections.clear(),
    db.nftItems.clear(),
    db.prices.clear(),
    db.historicalPrices.clear(),
    db.snapshots.clear(),
    db.exchangeBalances.clear(),
    db.exchangeLedger.clear(),
    db.blockMarkers.clear(),
  ]);
};
