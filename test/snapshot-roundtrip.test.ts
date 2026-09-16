import type { StoredBalance, StoredNftItem, StoredToken } from 'lib/db/schema';
import { buildSnapshotFacts } from 'lib/history/snapshot';
import type { AggregationInput } from 'lib/portfolio/aggregate';
import { assemblePortfolio } from 'lib/portfolio/assemble';
import { buildAggregationInputFromSnapshot, type CurrentLens } from 'lib/portfolio/snapshot-input';
import { describe, expect, it, vi } from 'vitest';

vi.mock('lib/db', () => ({ db: {} }));

const OWNER_A = '0x1111111111111111111111111111111111111111';
const OWNER_B = '0x2222222222222222222222222222222222222222';
const WETH = '0x00000000000000000000000000000000000000e1';
const USDC = '0x00000000000000000000000000000000000000a1';
const APES = '0x00000000000000000000000000000000000000c1';

const SPAM = { dustThresholdUsd: 0, dustThresholdAmount: 0.000001, hideUnpricedTokens: false, useSpamHeuristics: true };

const token = (
  chainId: number,
  address: string,
  symbol: string,
  decimals: number,
  coingeckoId: string,
): StoredToken => ({
  id: `${chainId}:${address}`,
  chainId,
  address,
  standard: 'erc20',
  symbol,
  decimals,
  coingeckoId,
  isSpam: 0,
  metadataUpdatedAt: 0,
});

const balance = (chainId: number, owner: string, tokenAddress: string, amount: string): StoredBalance => ({
  id: `${chainId}:${owner}:${tokenAddress}`,
  chainId,
  owner,
  token: tokenAddress,
  standard: 'erc20',
  amount,
  updatedAt: 0,
});

const nftItem = (owner: string, tokenId: string): StoredNftItem => ({
  id: `1:${owner}:${APES}:${tokenId}`,
  chainId: 1,
  owner,
  collection: APES,
  tokenId,
  amount: '1',
  updatedAt: 0,
});

// A live portfolio spanning two wallets, two chains, an NFT collection, an exchange and a manual holding.
const LIVE_INPUT: AggregationInput = {
  balances: [
    balance(1, OWNER_A, WETH, '4000000000000000000'),
    balance(1, OWNER_B, WETH, '2000000000000000000'),
    balance(137, OWNER_A, USDC, '9000000000'),
  ],
  tokens: [token(1, WETH, 'WETH', 18, 'weth'), token(137, USDC, 'USDC', 6, 'usd-coin')],
  prices: [
    { id: 'coingecko:weth', priceUsd: 3000, updatedAt: 0 },
    { id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: 0 },
    { id: 'coingecko:bitcoin', priceUsd: 90000, updatedAt: 0 },
    { id: 'coingecko:solana', priceUsd: 200, updatedAt: 0 },
  ],
  overrides: [],
  nftCollections: [
    {
      id: `1:${APES}`,
      chainId: 1,
      address: APES,
      standard: 'erc721',
      name: 'Test Apes',
      floorPriceUsd: 2500,
      metadataUpdatedAt: 0,
    },
  ],
  nftItems: [nftItem(OWNER_A, '1'), nftItem(OWNER_A, '2'), nftItem(OWNER_B, '3')],
  exchangeBalances: [{ id: 'acct:BTC', accountId: 'acct', asset: 'BTC', amount: '0.5', updatedAt: 0 }],
  exchangeAccounts: [{ id: 'acct', label: 'Kraken', exchange: 'kraken' }],
  exchangeAssetCoingeckoIds: { BTC: 'bitcoin' },
  manualHoldings: [
    {
      balance: {
        id: 'm1',
        symbol: 'SOL',
        location: 'Solana',
        wallet: 'Ledger',
        coingeckoId: 'solana',
        createdAt: 0,
        enabled: 1,
      },
      amount: 10,
      entryCount: 1,
    },
  ],
  categoryAssignments: [{ id: 'coin:weth', categoryId: 'c1', updatedAt: 0 }],
  spamSettings: SPAM,
};

const LENS: CurrentLens = {
  overrides: [],
  categoryAssignments: LIVE_INPUT.categoryAssignments ?? [],
  spamSettings: SPAM,
  liveTokens: LIVE_INPUT.tokens,
};

// The design's central promise: a recorded snapshot, rendered back through the adapter, is the live
// dashboard's output, figure for figure. If this drifts, the pinned view is lying about the past.
describe('recording and re-rendering a snapshot', () => {
  const facts = buildSnapshotFacts(LIVE_INPUT);
  const snapshot = { timestamp: 1_000, totalUsd: 0, createdAt: 1_000, ...facts };

  const live = assemblePortfolio(LIVE_INPUT);
  const replayed = assemblePortfolio(buildAggregationInputFromSnapshot(snapshot, LENS));

  it('reproduces the totals exactly', () => {
    expect(replayed.totals).toEqual(live.totals);
  });

  it('reproduces every aggregated row, locations included', () => {
    expect(replayed.tokens).toEqual(live.tokens);
    expect(replayed.nftCollections).toEqual(live.nftCollections);
  });

  it('reproduces the per-chain breakdowns the live tiles show', () => {
    expect(replayed.tokenChainBreakdown).toEqual(live.tokenChainBreakdown);
    expect(replayed.nftChainBreakdown).toEqual(live.nftChainBreakdown);
    expect(replayed.exchangeBreakdown).toEqual(live.exchangeBreakdown);
    expect(replayed.manualBreakdown).toEqual(live.manualBreakdown);
  });

  it('keeps the owner on every stored balance row', () => {
    expect(facts.balances.map((row) => row.owner).sort()).toEqual([OWNER_A, OWNER_A, OWNER_B]);
    expect(facts.nftHoldings.map((row) => [row.owner, row.count]).sort()).toEqual([
      [OWNER_A, 2],
      [OWNER_B, 1],
    ]);
  });

  it('stores only the metadata and prices the held assets need', () => {
    expect(facts.tokens.map((row) => row.id).sort()).toEqual([`137:${USDC}`, `1:${WETH}`]);
    expect(facts.prices.map((row) => row.id).sort()).toEqual([
      'coingecko:bitcoin',
      'coingecko:solana',
      'coingecko:usd-coin',
      'coingecko:weth',
    ]);
  });

  it('never freezes logos, which stay a live borrow', () => {
    expect(JSON.stringify(facts)).not.toContain('logoUrl');
  });
});

// A snapshot recorded while a chain was still supported keeps that chain's rows forever. Once the chain is
// dropped the live portfolio stops counting it, so a pinned point must stop counting it too.
describe('replaying a snapshot that holds a chain which is no longer supported', () => {
  const REMOVED_CHAIN_ID = 25; // Cronos

  const facts = buildSnapshotFacts(LIVE_INPUT);
  const snapshot = {
    timestamp: 1_000,
    totalUsd: 0,
    createdAt: 1_000,
    ...facts,
    balances: [...facts.balances, { chainId: REMOVED_CHAIN_ID, owner: OWNER_A, token: USDC, amount: '5000000000' }],
    tokens: [
      ...facts.tokens,
      {
        id: `${REMOVED_CHAIN_ID}:${USDC}`,
        chainId: REMOVED_CHAIN_ID,
        address: USDC,
        symbol: 'USDC',
        decimals: 6,
        coingeckoId: 'usd-coin',
      },
    ],
    nftCollections: [
      ...facts.nftCollections,
      {
        id: `${REMOVED_CHAIN_ID}:${APES}`,
        chainId: REMOVED_CHAIN_ID,
        address: APES,
        name: 'Removed Apes',
        floorPriceUsd: 100,
      },
    ],
    nftHoldings: [...facts.nftHoldings, { chainId: REMOVED_CHAIN_ID, collection: APES, owner: OWNER_A, count: 3 }],
  };

  const input = buildAggregationInputFromSnapshot(snapshot, LENS);

  it('leaves out every balance, token, collection and holding on that chain', () => {
    const chainIdsOf = (rows: { chainId: number }[]) => rows.map((row) => row.chainId);

    expect(chainIdsOf(input.balances)).not.toContain(REMOVED_CHAIN_ID);
    expect(chainIdsOf(input.tokens)).not.toContain(REMOVED_CHAIN_ID);
    expect(chainIdsOf(input.nftCollections)).not.toContain(REMOVED_CHAIN_ID);
    expect(chainIdsOf(input.nftItems)).not.toContain(REMOVED_CHAIN_ID);
  });

  it('values the point exactly as the live portfolio does', () => {
    expect(assemblePortfolio(input).totals).toEqual(assemblePortfolio(LIVE_INPUT).totals);
  });
});
