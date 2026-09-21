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
  // Collection-level icons, one field per source so neither can mask the other: the revoke.cash whois
  // dataset's, and the image CoinGecko returns alongside the floor price. The aggregation shows the whois icon
  // where there is one. Items' own artwork is deliberately never stored.
  whoisImageUrl?: string;
  coingeckoImageUrl?: string;
  // CoinGecko's own collection id, when it has one. Needed for historical floor prices, which are keyed by
  // it rather than by contract address.
  coingeckoNftId?: string;
  // When we last asked CoinGecko whether it indexes this collection. Recorded separately from the floor
  // price timestamp because the two answers go stale at completely different rates: a floor moves hourly,
  // but whether a collection exists in CoinGecko's index at all changes rarely.
  coingeckoCheckedAt?: number;
  // When the whois dataset was last consulted for this collection's icon. Tracked separately from
  // `metadataUpdatedAt` for the same reason tokens do: a collection added to the dataset later still picks up
  // an icon, and one absent from it is not re-requested on every sync.
  whoisCheckedAt?: number;
  // Floor price in the collection's own denominating currency, plus its USD conversion at fetch time.
  floorPrice?: number;
  floorPriceCurrency?: string;
  floorPriceUsd?: number;
  // Which source the current floor came from, so the UI can be honest about where a valuation originated.
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

// What a snapshot measured, as opposed to what it found.
//
// Recorded so that a later run can tell whether a point is still measuring the same portfolio the app is
// measuring today. Absent on every row written before this existed, and absent means unknown rather than
// "assumed to be the current one".
export interface SnapshotScope {
  // Lowercase, sorted.
  wallets: string[];
  // The sync setting verbatim rather than the chain list it resolves to. Storing the resolved list would
  // make every stamp drift the day the app adds support for another chain.
  chainIds: number[] | null;
  includeTestnets: boolean;
}

// One wallet's holding of one token on one chain at the snapshot's moment, in raw units.
//
// Snapshots store the portfolio's facts rather than a rendered summary: the same rows the live dashboard
// aggregates, frozen. Rendering a pinned snapshot then runs the same aggregation the live view runs, so
// the two can never drift apart, and per-chain breakdowns work for the past exactly as for the present.
// Keeping the owner on every row is also what makes wallet-scope corrections plain arithmetic: removing a
// wallet from a point is dropping its rows.
export interface SnapshotChainBalance {
  chainId: number;
  owner: string;
  token: string;
  // Raw units as a decimal string, exactly as balances are stored live. A reconstructed point converts its
  // replayed amounts back to raw units, so both kinds of snapshot share one shape.
  amount: string;
}

// The metadata needed to value and label a held token, frozen so a snapshot stays renderable even if the
// live tokens table forgets the token. Logos are deliberately absent: they are cosmetic, current, and
// resolved from the live table at render time with a graceful fallback.
export interface SnapshotTokenMetadata {
  id: string;
  chainId: number;
  address: string;
  symbol?: string;
  decimals?: number;
  coingeckoId?: string;
  isSpam?: 0 | 1;
  spamReason?: string;
}

export interface SnapshotPrice {
  // The price-key space the live prices table uses: `coingecko:<id>` or `<chainId>:<address>`.
  id: string;
  priceUsd: number | null;
}

export interface SnapshotNftCollectionFact {
  id: string;
  chainId: number;
  address: string;
  name?: string;
  floorPriceUsd: number | null;
}

export interface SnapshotNftHolding {
  chainId: number;
  collection: string;
  owner: string;
  count: number;
}

export interface SnapshotExchangeBalance {
  accountId: string;
  asset: string;
  amount: string;
}

// Enough of the account to label its holdings if the account itself is later removed.
export interface SnapshotExchangeAccountFact {
  id: string;
  label: string;
  exchange: ExchangeKind;
}

export interface SnapshotManualHolding {
  balanceId: string;
  symbol: string;
  coingeckoId?: string;
  location: string;
  wallet?: string;
  amount: number;
}

export interface StoredSnapshot {
  // The moment the snapshot describes, as a millisecond timestamp, and the primary key. Either the moment
  // a sync finished or a past moment the user asked to reconstruct, so re-adding the same moment replaces
  // it rather than producing a second point on top of the first.
  timestamp: number;
  // What the visible portfolio totalled, under the filters in force when the point was written. Stored so
  // the chart never has to aggregate every point to draw a line.
  totalUsd: number;
  createdAt: number;
  balances: SnapshotChainBalance[];
  tokens: SnapshotTokenMetadata[];
  prices: SnapshotPrice[];
  nftCollections: SnapshotNftCollectionFact[];
  nftHoldings: SnapshotNftHolding[];
  exchangeBalances: SnapshotExchangeBalance[];
  exchangeAccounts: SnapshotExchangeAccountFact[];
  // The ticker-to-coin resolution as it stood, frozen because it is part of how the figures were valued.
  exchangeAssetCoingeckoIds: Record<string, string>;
  manualHoldings: SnapshotManualHolding[];
  // Units of each currency per US dollar at the time, for valuing cash held on exchanges.
  fiatRatesPerUsd?: Record<string, number>;
  scope?: SnapshotScope;
  // The wallets whose holdings this point can account for. Owners appear on the rows themselves; this
  // list additionally names wallets that were measured and held nothing, so they are not re-measured as
  // though they were never looked at. An empty owner string on a row means a reconstruction that could
  // not attribute it.
  attributedOwners?: string[];
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

// A holding the app cannot discover for itself: a Bitcoin or Solana balance, a hardware wallet, anything on
// a chain that is not supported. The user says what it is, where it is, and how to price it.
//
// The amount is deliberately not stored here. It is summed from the ledger below, so that the balance and
// the history telling you how it got there can never disagree.
export interface StoredManualBalance {
  id: string;
  // What the holding is called in the portfolio, e.g. BTC. Uppercased, since it is matched and displayed
  // the same way exchange tickers are.
  symbol: string;
  // The chain or exchange it is on: "Bitcoin", "Solana", "Kraken". Free text rather than a chain id, because
  // the holdings that need recording by hand are exactly the ones on networks the app does not support.
  location: string;
  // Which wallet within that location, when it matters: "Ledger", "Phantom", "cold storage". Optional, since
  // an exchange balance or a single-wallet chain has nothing useful to put here.
  wallet?: string;
  // The CoinGecko coin id to price it by, which is the same identity the rest of the portfolio aggregates
  // on: give a manual BTC holding `bitcoin` and it joins the row with the BTC on your exchange. Optional,
  // because tracking a quantity of something unpriceable is still worth doing.
  coingeckoId?: string;
  createdAt: number;
  enabled: 0 | 1;
}

// One buy or sell against a manual balance. Together they are the whole history of that holding, which is
// what lets a reconstructed snapshot know what it was worth at a past moment rather than assuming today's
// quantity has always been held.
export interface StoredManualLedgerEntry {
  id: string;
  balanceId: string;
  kind: 'buy' | 'sell';
  // Always positive; `kind` carries the direction. Stored as a decimal string for the same reason exchange
  // amounts are: these are human-scale quantities with per-asset precision.
  amount: string;
  timestamp: number;
  note?: string;
}

export interface StoredTokenOverride {
  // `${chainId}:${token}`, or `exchange:${asset}` for exchange-held assets.
  id: string;
  // A manual decision that beats every automatic spam and dust rule, in both directions.
  hidden: 0 | 1;
  updatedAt: number;
}

// A grouping the user invented, for looking at the portfolio through their own lens rather than through
// chains and tickers. "Blue chip", "stablecoins", "long tail": the app has no opinion about what the
// categories should be, only that an asset belongs to at most one of them.
export interface StoredAssetCategory {
  id: string;
  name: string;
  // The user's own ordering. It also fixes the colour each category gets on a chart, so that a category
  // keeps its colour when its value changes and it moves in the ranking.
  sortIndex: number;
  createdAt: number;
}

export interface StoredCategoryAssignment {
  // The asset's stable identity: a token's override key, or `${chainId}:${address}` for an NFT collection.
  //
  // Those two share a format, which is safe because they cannot collide: one contract address on one chain
  // is one contract, and it is either a token or a collection, never both.
  id: string;
  categoryId: string;
  updatedAt: number;
}

export interface StoredBlockMarker {
  // `${chainId}:${timestamp}`
  id: string;
  chainId: number;
  timestamp: number;
  blockNumber: number;
}
