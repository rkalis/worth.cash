import Dexie, { type Table } from 'dexie';
import type {
  StoredAssetCategory,
  StoredBalance,
  StoredBlockMarker,
  StoredCategoryAssignment,
  StoredExchangeAccount,
  StoredExchangeBalance,
  StoredExchangeLedgerEntry,
  StoredHistoricalPrice,
  StoredManualBalance,
  StoredManualLedgerEntry,
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
  manualBalances!: Table<StoredManualBalance, string>;
  manualLedger!: Table<StoredManualLedgerEntry, string>;
  assetCategories!: Table<StoredAssetCategory, string>;
  categoryAssignments!: Table<StoredCategoryAssignment, string>;

  constructor() {
    super('worth.cash');

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
      // openseaSlug stays in this historical version declaration even though the integration is gone:
      // version definitions describe what existed at the time, and version 4 below drops the index.
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

    // Manual balances arrived later. Adding stores in a new version leaves every existing table untouched,
    // so no data is rebuilt to get them.
    this.version(2).stores({
      manualBalances: 'id, enabled, symbol',
      manualLedger: 'id, [balanceId+timestamp], balanceId, timestamp',
    });

    // Categories, added the same way: two new stores, nothing existing touched. An asset with no assignment
    // row is uncategorised, which is the state every asset starts in.
    this.version(3).stores({
      assetCategories: 'id, sortIndex',
      categoryAssignments: 'id, categoryId',
    });

    // The OpenSea integration was removed; this drops its index. Stored rows keep any openseaSlug field
    // they already carry, which Dexie simply no longer indexes or reads.
    this.version(4).stores({
      nftCollections: 'id, [chainId+address], chainId',
    });

    // Snapshots changed shape entirely: they now store the portfolio's raw facts rather than rendered
    // positions, so a pinned snapshot renders through the same aggregation as the live view. Old-format
    // rows cannot be converted (they lost the facts at write time), so they are cleared; history rebuilds
    // from syncs and the weekly backfill. Settings, wallets, ledgers and categories are untouched.
    this.version(5)
      .stores({})
      .upgrade((transaction) => transaction.table('snapshots').clear());

    // NFT artwork and per-token metadata were removed: NFTs are counted and valued at their floor, nothing
    // more. The fields are stripped from stored rows so the dead data neither lingers nor travels in
    // exports. Collection names stay, since they are how one collection is told apart from another.
    // Collection-level icons were later brought back from the whois dataset; clearing the old values here
    // only means the next sync fills them in again.
    this.version(6)
      .stores({})
      .upgrade(async (transaction) => {
        await transaction
          .table('nftItems')
          .toCollection()
          .modify((item) => {
            delete item.name;
            delete item.imageUrl;
          });
        await transaction
          .table('nftCollections')
          .toCollection()
          .modify((collection) => {
            delete collection.imageUrl;
          });
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
