import { isSupportedChain } from 'lib/chains';
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
// Token logos and collection icons are cosmetic and come from the live tables, with the same fallbacks the
// live view has when they are missing.
export interface CurrentLens {
  overrides: StoredTokenOverride[];
  categoryAssignments: StoredCategoryAssignment[];
  spamSettings: SpamSettings;
  coinLogoUrls?: Record<string, string>;
  // Which coins are bridged copies of which. Grouping is how a portfolio reads rather than what it held, and
  // each copy is still valued at the price the snapshot froze for it, so a past point merges its WETHs
  // exactly as today does without any figure in it changing.
  canonicalCoinIds?: Record<string, string>;
  // Live rows, only for their logos and icons. Missing rows cost a placeholder, nothing more.
  liveTokens: StoredToken[];
  liveNftCollections: StoredNftCollection[];
}

// Turns a stored snapshot back into the aggregation's input, so a pinned point renders through exactly
// the code path the live dashboard renders through. That identity is the whole design: there is one
// definition of how a portfolio is aggregated, and history replays it rather than approximating it.
//
// Chain support is part of the lens too. A snapshot can hold rows from a chain that has since been dropped
// from the chain list, and the live portfolio no longer counts such a chain at all. Its balances, tokens and
// NFTs are left out here as well, so a pinned point, and the total recomputed from it, agree with the
// dashboard instead of resurrecting money the dashboard cannot show.
export const buildAggregationInputFromSnapshot = (snapshot: StoredSnapshot, lens: CurrentLens): AggregationInput => {
  const liveTokensById = new Map(lens.liveTokens.map((token) => [token.id, token]));
  const liveCollectionsById = new Map(lens.liveNftCollections.map((collection) => [collection.id, collection]));
  const isOnSupportedChain = (row: { chainId: number }): boolean => isSupportedChain(row.chainId);

  const tokens: StoredToken[] = (snapshot.tokens ?? []).filter(isOnSupportedChain).map((token) => ({
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

  const nftCollections: StoredNftCollection[] = (snapshot.nftCollections ?? [])
    .filter(isOnSupportedChain)
    .map((collection) => ({
      id: collection.id,
      chainId: collection.chainId,
      address: collection.address,
      standard: 'erc721',
      name: collection.name,
      whoisImageUrl: liveCollectionsById.get(collection.id)?.whoisImageUrl,
      coingeckoImageUrl: liveCollectionsById.get(collection.id)?.coingeckoImageUrl,
      floorPriceUsd: collection.floorPriceUsd ?? undefined,
      floorPriceUpdatedAt: snapshot.timestamp,
      metadataUpdatedAt: snapshot.timestamp,
    }));

  // The aggregation counts items per (collection, owner) and sums their amounts; one synthetic row per
  // holding carries the same information the itemised live rows do.
  const nftItems: StoredNftItem[] = (snapshot.nftHoldings ?? []).filter(isOnSupportedChain).map((holding) => ({
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
    balances: (snapshot.balances ?? []).filter(isOnSupportedChain).map((balance) => ({
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
    canonicalCoinIds: lens.canonicalCoinIds,
    fiatRatesPerUsd: snapshot.fiatRatesPerUsd,
    categoryAssignments: lens.categoryAssignments,
    spamSettings: lens.spamSettings,
  };
};
