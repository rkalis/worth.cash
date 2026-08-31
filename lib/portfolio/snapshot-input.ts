import type {
  StoredCategoryAssignment,
  StoredNftCollection,
  StoredNftItem,
  StoredSnapshot,
  StoredToken,
  StoredTokenOverride,
} from 'lib/db/schema';
import type { ManualHolding } from 'lib/manual/balances';
import type { AggregationInput } from 'lib/portfolio/aggregate';
import type { SpamSettings } from 'lib/settings/types';

// What the pinned view borrows from the present.
//
// A snapshot freezes the facts: what was held, where, and what it was worth. Everything here is a lens
// rather than a fact, current on purpose: hiding a token, filing it under a category, or tightening the
// spam filters should change how every point in history reads, exactly as it changes the present.
// Logos and collection artwork are cosmetic and come from the live tables, with the same fallbacks the
// live view has when they are missing.
export interface CurrentLens {
  overrides: StoredTokenOverride[];
  categoryAssignments: StoredCategoryAssignment[];
  spamSettings: SpamSettings;
  coinLogoUrls?: Record<string, string>;
  // Live rows, only for their logoUrl / imageUrl. Missing rows cost a placeholder, nothing more.
  liveTokens: StoredToken[];
  liveNftCollections: StoredNftCollection[];
}

// Turns a stored snapshot back into the aggregation's input, so a pinned point renders through exactly
// the code path the live dashboard renders through. That identity is the whole design: there is one
// definition of how a portfolio is aggregated, and history replays it rather than approximating it.
export const buildAggregationInputFromSnapshot = (snapshot: StoredSnapshot, lens: CurrentLens): AggregationInput => {
  const liveTokensById = new Map(lens.liveTokens.map((token) => [token.id, token]));
  const liveCollectionsById = new Map(lens.liveNftCollections.map((collection) => [collection.id, collection]));

  const tokens: StoredToken[] = (snapshot.tokens ?? []).map((token) => ({
    id: token.id,
    chainId: token.chainId,
    address: token.address,
    standard: 'erc20',
    symbol: token.symbol,
    decimals: token.decimals,
    coingeckoId: token.coingeckoId,
    isSpam: token.isSpam ?? 0,
    spamReason: token.spamReason,
    // The one live borrow: artwork. The frozen metadata deliberately carries none.
    logoUrl: liveTokensById.get(token.id)?.logoUrl,
    metadataUpdatedAt: 0,
  }));

  const nftCollections: StoredNftCollection[] = (snapshot.nftCollections ?? []).map((collection) => ({
    id: collection.id,
    chainId: collection.chainId,
    address: collection.address,
    standard: 'erc721',
    name: collection.name,
    imageUrl: liveCollectionsById.get(collection.id)?.imageUrl,
    floorPriceUsd: collection.floorPriceUsd ?? undefined,
    floorPriceUpdatedAt: snapshot.timestamp,
    metadataUpdatedAt: snapshot.timestamp,
  }));

  // The aggregation counts items per (collection, owner) and sums their amounts; one synthetic row per
  // holding carries the same information the itemised live rows do.
  const nftItems: StoredNftItem[] = (snapshot.nftHoldings ?? []).map((holding) => ({
    id: `${holding.chainId}:${holding.owner}:${holding.collection}:snapshot`,
    chainId: holding.chainId,
    owner: holding.owner,
    collection: holding.collection,
    tokenId: '0',
    standard: 'erc721',
    amount: String(holding.count),
    updatedAt: snapshot.timestamp,
  }));

  const manualHoldings: ManualHolding[] = (snapshot.manualHoldings ?? []).map((holding) => ({
    balance: {
      id: holding.balanceId,
      symbol: holding.symbol,
      location: holding.location,
      wallet: holding.wallet,
      coingeckoId: holding.coingeckoId,
      createdAt: 0,
      enabled: 1,
    },
    amount: holding.amount,
    entryCount: 0,
  }));

  return {
    balances: (snapshot.balances ?? []).map((balance) => ({
      id: `${balance.chainId}:${balance.owner}:${balance.token}`,
      chainId: balance.chainId,
      owner: balance.owner,
      token: balance.token,
      standard: 'erc20',
      amount: balance.amount,
      updatedAt: snapshot.timestamp,
    })),
    tokens,
    prices: (snapshot.prices ?? []).map((price) => ({
      id: price.id,
      priceUsd: price.priceUsd,
      updatedAt: snapshot.timestamp,
    })),
    overrides: lens.overrides,
    nftCollections,
    nftItems,
    exchangeBalances: (snapshot.exchangeBalances ?? []).map((balance) => ({
      id: `${balance.accountId}:${balance.asset}`,
      accountId: balance.accountId,
      asset: balance.asset,
      amount: balance.amount,
      updatedAt: snapshot.timestamp,
    })),
    exchangeAccounts: snapshot.exchangeAccounts ?? [],
    exchangeAssetCoingeckoIds: snapshot.exchangeAssetCoingeckoIds ?? {},
    manualHoldings,
    coinLogoUrls: lens.coinLogoUrls,
    fiatRatesPerUsd: snapshot.fiatRatesPerUsd,
    categoryAssignments: lens.categoryAssignments,
    spamSettings: lens.spamSettings,
  };
};
