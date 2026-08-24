import type { TokenStandard } from 'lib/events';

// Storage conventions, applied consistently across every table:
//
//  - Addresses are stored lowercase so that a compound key or index matches regardless of how the address
//    was cased when it entered the app. They are re-checksummed with `getAddress` on the way out.
//  - `bigint` values are stored as decimal strings. IndexedDB can clone a bigint but cannot index one, and
//    a mix of the two in the same column would sort incorrectly.
//  - Booleans are stored as 0/1, because IndexedDB cannot index a boolean.
//  - Ids are deterministic composite strings rather than autoincrementing numbers, so that re-syncing the
//    same data updates rows in place instead of duplicating them.

export interface StoredSetting {
  key: string;
  value: unknown;
}

export interface StoredWallet {
  // Lowercase address, and the primary key.
  address: string;
  label?: string;
  ensName?: string;
  addedAt: number;
  enabled: 0 | 1;
}

export type ExchangeKind = 'coinbase' | 'kraken';

export interface StoredExchangeAccount {
  id: string;
  exchange: ExchangeKind;
  label: string;
  // API credentials in plain text: this is a personal, self-hosted app whose balances refresh unattended, so
  // there is nowhere to keep a secret the app itself cannot read. Anyone with access to this browser profile
  // can read them, which is why the settings UI asks for read-only keys. See the README's known limitations.
  apiKey: string;
  apiSecret: string;
  // Coinbase CDP keys carry a key name of the form `organizations/{org}/apiKeys/{key}` in place of a plain
  // key id; Kraken has no equivalent field.
  keyName?: string;
  addedAt: number;
  enabled: 0 | 1;
}

export interface StoredTransferEvent {
  // `${chainId}:${owner}:${transactionHash}:${logIndex}`.
  //
  // The owner is part of the key on purpose. A transfer between two wallets you both track is one log but
  // two facts, and keying on the log alone would let the second wallet's row overwrite the first's.
  id: string;
  chainId: number;
  owner: string;
  token: string;
  standard: TokenStandard;
  from: string;
  to: string;
  // Base units for ERC20, always 1 for ERC721, and the transferred quantity for ERC1155.
  amount: string;
  tokenId?: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
  // Only present when the log source supplied it. History is reconstructed from `blockNumber` rather than
  // from this field, precisely because plain `eth_getLogs` usually omits it.
  timestamp?: number;
}

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface StoredSyncCursor {
  // `${chainId}:${owner}`
  id: string;
  chainId: number;
  owner: string;
  // The last block whose logs are fully recorded. Resuming from here is what makes a sync incremental.
  lastSyncedBlock: number;
  // The block this chain's history starts at for this owner. Zero unless a sync was bounded on purpose.
  firstSyncedBlock: number;
  lastSyncedAt: number;
  status: SyncStatus;
  error?: string;
}

export interface StoredToken {
  // `${chainId}:${address}`
  id: string;
  chainId: number;
  address: string;
  standard: TokenStandard;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoUrl?: string;
  coingeckoId?: string;
  isSpam: 0 | 1;
  spamReason?: string;
  // When the whois dataset was last consulted for this token. Tracked separately from
  // `metadataUpdatedAt` so that a token added to the dataset later still picks up a logo, and one that is
  // absent from it is not re-requested on every single sync.
  whoisCheckedAt?: number;
  metadataUpdatedAt: number;
}

export interface StoredBalance {
  // `${chainId}:${owner}:${token}`
  id: string;
  chainId: number;
  owner: string;
  token: string;
  standard: TokenStandard;
  amount: string;
  updatedAt: number;
}

export interface StoredNftCollection {
  // `${chainId}:${address}`
  id: string;
  chainId: number;
  address: string;
  standard: 'erc721' | 'erc1155';
  name?: string;
  symbol?: string;
  imageUrl?: string;
  openseaSlug?: string;
  // CoinGecko's own collection id, when it has one. Needed for historical floor prices, which are keyed by
  // it rather than by contract address.
  coingeckoNftId?: string;
  // When we last asked CoinGecko whether it indexes this collection. Recorded separately from the floor
  // price timestamp because the two answers go stale at completely different rates: a floor moves hourly,
  // but whether a collection exists in CoinGecko's index at all changes rarely.
  coingeckoCheckedAt?: number;
  // Floor price in the collection's own denominating currency, plus its USD conversion at fetch time.
  floorPrice?: number;
  floorPriceCurrency?: string;
  floorPriceUsd?: number;
  // Which source the current floor came from, so the UI can be honest about where a valuation originated.
  floorPriceSource?: 'coingecko' | 'opensea';
  floorPriceUpdatedAt?: number;
  metadataUpdatedAt: number;
}

export interface StoredNftItem {
  // `${chainId}:${owner}:${collection}:${tokenId}`
  id: string;
  chainId: number;
  owner: string;
  collection: string;
  tokenId: string;
  // Always 1 for ERC721. ERC1155 items can be held in quantity.
  amount: string;
  name?: string;
  imageUrl?: string;
  updatedAt: number;
}

export interface StoredPrice {
  // Either `${chainId}:${tokenAddress}` for on-chain tokens, or `coingecko:${coingeckoId}` for assets we
  // price by id (native tokens and everything held on an exchange).
  id: string;
  // Null records a confirmed absence of a price, which is different from "not looked up yet" and stops us
  // from asking again on every refresh.
  priceUsd: number | null;
  updatedAt: number;
}

export interface StoredHistoricalPrice {
  // `${priceKey}:${timestamp}`
  id: string;
  priceKey: string;
  // Start of the UTC day the price belongs to.
  timestamp: number;
  priceUsd: number;
}

export interface SnapshotPosition {
  // Matches the `id` of a StoredPrice, so a snapshot can be re-valued later without re-deriving keys.
  priceKey: string;
  symbol: string;
  amount: number;
  priceUsd: number | null;
  valueUsd: number;
  kind: 'token' | 'nft' | 'exchange';
}

export interface StoredSnapshot {
  // Monday 09:00 UTC, as a millisecond timestamp, and the primary key.
  timestamp: number;
  totalUsd: number;
  createdAt: number;
  // Positions are stored inline rather than in their own table: a snapshot is always read whole, and the
  // row count would otherwise grow by the size of the portfolio every single week.
  positions: SnapshotPosition[];
}

export interface StoredExchangeBalance {
  // `${accountId}:${asset}`
  id: string;
  accountId: string;
  asset: string;
  // A decimal string rather than base units, since exchanges report human-scale amounts and each asset's
  // precision differs.
  amount: string;
  updatedAt: number;
}

export interface StoredExchangeLedgerEntry {
  // `${accountId}:${entryId}`
  id: string;
  accountId: string;
  asset: string;
  // Signed: negative for withdrawals and outgoing trades.
  amount: string;
  timestamp: number;
  type: string;
}

export interface StoredTokenOverride {
  // `${chainId}:${token}`, or `exchange:${asset}` for exchange-held assets.
  id: string;
  // A manual decision that beats every automatic spam and dust rule, in both directions.
  hidden: 0 | 1;
  updatedAt: number;
}

export interface StoredBlockMarker {
  // `${chainId}:${timestamp}`
  id: string;
  chainId: number;
  timestamp: number;
  blockNumber: number;
}
