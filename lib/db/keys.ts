import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import type { Address } from 'viem';

// Every composite primary key in the database is built here, so that a writer and a reader can never
// disagree about the format. All address components are lowercased.

const lower = (value: string) => value.toLowerCase();

export const tokenKey = (chainId: number, token: Address | string) => `${chainId}:${lower(token)}`;

export const balanceKey = (chainId: number, owner: Address | string, token: Address | string) =>
  `${chainId}:${lower(owner)}:${lower(token)}`;

export const transferEventKey = (chainId: number, owner: Address | string, transactionHash: string, logIndex: number) =>
  `${chainId}:${lower(owner)}:${lower(transactionHash)}:${logIndex}`;

export const syncCursorKey = (chainId: number, owner: Address | string) => `${chainId}:${lower(owner)}`;

export const nftCollectionKey = (chainId: number, address: Address | string) => `${chainId}:${lower(address)}`;

export const nftItemKey = (chainId: number, owner: Address | string, collection: Address | string, tokenId: string) =>
  `${chainId}:${lower(owner)}:${lower(collection)}:${tokenId}`;

export const exchangeBalanceKey = (accountId: string, asset: string) => `${accountId}:${asset.toUpperCase()}`;

export const exchangeLedgerKey = (accountId: string, entryId: string) => `${accountId}:${entryId}`;

export const blockMarkerKey = (chainId: number, timestamp: number) => `${chainId}:${timestamp}`;

export const historicalPriceKey = (priceKey: string, timestamp: number) => `${priceKey}:${timestamp}`;

// Price keys identify what a price is *for*, across both on-chain tokens and exchange-held assets.
//
// On-chain tokens are keyed by chain and contract, because the same symbol means different things on
// different chains. Everything else is keyed by CoinGecko id, which is what we can actually look up for a
// native token or for BTC sitting on Kraken.
export const onChainPriceKey = (chainId: number, token: Address | string) => `${chainId}:${lower(token)}`;

export const coingeckoPriceKey = (coingeckoId: string) => `coingecko:${lower(coingeckoId)}`;

export const isNativeToken = (token: Address | string) => lower(token) === lower(NATIVE_TOKEN_ADDRESS);

export const tokenOverrideKey = (chainId: number, token: Address | string) => `${chainId}:${lower(token)}`;

export const exchangeAssetOverrideKey = (asset: string) => `exchange:${asset.toUpperCase()}`;
