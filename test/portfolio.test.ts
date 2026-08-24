import { createEnabledChainFilter } from 'lib/chains/enabled';
import type {
  StoredBalance,
  StoredExchangeBalance,
  StoredManualBalance,
  StoredToken,
  StoredTransferEvent,
} from 'lib/db/schema';
import { normaliseExchangeAsset } from 'lib/exchanges/types';
import { mergeNativeBalanceSeries } from 'lib/history/reconstruct';
import {
  type AggregationInput,
  aggregateNftCollections,
  aggregateTokens,
  calculateTotals,
} from 'lib/portfolio/aggregate';
import { classifyTokenSpam } from 'lib/portfolio/spam';
import { DEFAULT_SETTINGS } from 'lib/settings/types';
import { deriveHeldNfts } from 'lib/sync/nfts';
import { describe, expect, it } from 'vitest';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const spamSettings = { dustThresholdUsd: 1, hideUnpricedTokens: true, useSpamHeuristics: true };

const buildToken = (chainId: number, address: string, overrides: Partial<StoredToken> = {}): StoredToken => ({
  id: `${chainId}:${address}`,
  chainId,
  address,
  standard: 'erc20',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  isSpam: 0,
  metadataUpdatedAt: Date.now(),
  ...overrides,
});

const buildBalance = (chainId: number, address: string, amount: string, owner: string = OWNER): StoredBalance => ({
  id: `${chainId}:${owner}:${address}`,
  chainId,
  owner,
  token: address,
  standard: 'erc20',
  amount,
  updatedAt: Date.now(),
});

const buildExchangeBalance = (accountId: string, asset: string, amount: string): StoredExchangeBalance => ({
  id: `${accountId}:${asset}`,
  accountId,
  asset,
  amount,
  updatedAt: Date.now(),
});

const KRAKEN_ACCOUNT = { id: 'kraken-1', label: 'Kraken', exchange: 'kraken' as const };
const COINBASE_ACCOUNT = { id: 'coinbase-1', label: 'Coinbase', exchange: 'coinbase' as const };

const buildManualHolding = (
  id: string,
  symbol: string,
  amount: number,
  overrides: Partial<StoredManualBalance> = {},
) => ({
  balance: {
    id,
    symbol,
    location: 'Ledger Nano',
    coingeckoId: symbol.toLowerCase() === 'btc' ? 'bitcoin' : undefined,
    createdAt: 0,
    enabled: 1 as const,
    ...overrides,
  },
  amount,
  entryCount: 1,
});

const buildInput = (overrides: Partial<AggregationInput>): AggregationInput => ({
  balances: [],
  tokens: [],
  prices: [],
  overrides: [],
  nftCollections: [],
  nftItems: [],
  exchangeBalances: [],
  exchangeAccounts: [],
  exchangeAssetCoingeckoIds: {},
  spamSettings,
  ...overrides,
});

describe('aggregateTokens', () => {
  const usdcEthereum = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const usdcBase = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const usdcPolygon = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

  it('merges the same coin across chains into one position', () => {
    const result = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, usdcEthereum, '1000000'), buildBalance(8453, usdcBase, '2000000')],
        tokens: [
          buildToken(1, usdcEthereum, { coingeckoId: 'usd-coin' }),
          buildToken(8453, usdcBase, { coingeckoId: 'usd-coin' }),
        ],
        prices: [{ id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() }],
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].totalAmount).toBe(3);
    expect(result[0].valueUsd).toBe(3);
    expect(result[0].locations).toHaveLength(2);
  });

  // Names are attacker-controlled metadata, so the aggregated token deliberately carries none: the row shows
  // the symbol alone. The name is still stored, because spam classification reads it.
  it('exposes no name for a token, only its symbol', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, usdcEthereum, '1000000')],
        tokens: [buildToken(1, usdcEthereum, { coingeckoId: 'usd-coin', name: 'USD Coin' })],
        prices: [{ id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() }],
      }),
    );

    expect(position.symbol).toBe('USDC');
    expect('name' in position).toBe(false);
  });

  // The attack this exists to prevent. Deploying a token called USDC costs nothing, so an impostor sharing
  // the symbol must never join the real token's row, and must never be valued at the real token's price.
  it('refuses to merge an impostor that only shares the symbol', () => {
    const fakeUsdc = '0x9999999999999999999999999999999999999999';

    const result = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, usdcEthereum, '1000000'), buildBalance(1, fakeUsdc, '453037100000')],
        tokens: [
          buildToken(1, usdcEthereum, { coingeckoId: 'usd-coin' }),
          // No coin id: CoinGecko has never listed it, so it can only ever be its own asset.
          buildToken(1, fakeUsdc, { coingeckoId: undefined, name: 'USD-SWAP\u2024COM' }),
        ],
        prices: [{ id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() }],
      }),
    );

    expect(result).toHaveLength(2);

    const impostor = result.find((token) => token.overrideKey === `1:${fakeUsdc}`)!;
    expect(impostor.priceUsd).toBeNull();
    expect(impostor.valueUsd).toBeNull();
    // And it contributes nothing to the headline number.
    expect(calculateTotals(result, []).tokensUsd).toBe(1);
  });

  // Bridged and native versions of an asset are genuinely different coins to CoinGecko, and keeping them
  // apart is what stops a depegged bridged balance being valued at the native price.
  it('keeps bridged and native versions of an asset separate', () => {
    const bridgedUsdc = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

    const result = aggregateTokens(
      buildInput({
        balances: [buildBalance(137, usdcPolygon, '15010000'), buildBalance(137, bridgedUsdc, '1000000')],
        tokens: [
          buildToken(137, usdcPolygon, { coingeckoId: 'usd-coin', name: 'USD Coin' }),
          buildToken(137, bridgedUsdc, { coingeckoId: 'bridged-usdc-polygon-pos-bridge', name: 'USD Coin (PoS)' }),
        ],
        prices: [
          { id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() },
          { id: 'coingecko:bridged-usdc-polygon-pos-bridge', priceUsd: 0.99, updatedAt: Date.now() },
        ],
      }),
    );

    expect(result).toHaveLength(2);
  });

  // An unpriced token must stay unpriced. Previously it was absorbed into a priced group and took that
  // group's price, which is how worthless airdrops became five-figure balances.
  it('never lets an unpriced token inherit a price', () => {
    const unlisted = '0x8888888888888888888888888888888888888888';

    const [position] = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, unlisted, '1000000')],
        tokens: [buildToken(1, unlisted, { coingeckoId: undefined })],
        prices: [{ id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() }],
      }),
    );

    expect(position.priceUsd).toBeNull();
    expect(position.valueUsd).toBeNull();
    expect(position.isHidden).toBe(true);
  });

  it('sums the same token across wallets instead of listing the chain twice', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, usdcEthereum, '1000000', OWNER), buildBalance(1, usdcEthereum, '3000000', OTHER)],
        tokens: [buildToken(1, usdcEthereum, { coingeckoId: 'usd-coin' })],
        prices: [{ id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() }],
      }),
    );

    expect(position.locations).toHaveLength(1);
    expect(position.totalAmount).toBe(4);
  });

  it('hides positions worth less than the dust threshold', () => {
    const result = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, usdcEthereum, '100000')],
        tokens: [buildToken(1, usdcEthereum, { coingeckoId: 'usd-coin' })],
        prices: [{ id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() }],
      }),
    );

    expect(result[0].isHidden).toBe(true);
    expect(result[0].hiddenReason).toContain('dust');
  });

  it('lets a manual override beat automatic spam detection', () => {
    const spamToken = '0x8888888888888888888888888888888888888888';

    const result = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, spamToken, '1000000')],
        tokens: [buildToken(1, spamToken, { isSpam: 1, spamReason: 'spammy', symbol: 'SPAM', coingeckoId: 'spam' })],
        prices: [{ id: 'coingecko:spam', priceUsd: 5, updatedAt: Date.now() }],
        overrides: [{ id: `1:${spamToken}`, hidden: 0, updatedAt: Date.now() }],
      }),
    );

    expect(result[0].isHidden).toBe(false);
  });

  // Guessing 18 decimals would produce a number that looks plausible and is wrong by orders of magnitude.
  it('skips tokens whose decimals are unknown', () => {
    const unknownToken = '0x7777777777777777777777777777777777777777';

    const result = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, unknownToken, '1000000')],
        tokens: [buildToken(1, unknownToken, { decimals: undefined })],
      }),
    );

    expect(result).toHaveLength(0);
  });

  it('honours a hide override written against the key it reports as the override target', () => {
    const balances = [buildBalance(1, usdcEthereum, '1000000'), buildBalance(8453, usdcBase, '9000000')];
    const tokens = [
      buildToken(1, usdcEthereum, { coingeckoId: 'usd-coin' }),
      buildToken(8453, usdcBase, { coingeckoId: 'usd-coin' }),
    ];
    const prices = [{ id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() }];

    const [position] = aggregateTokens(buildInput({ balances, tokens, prices }));

    const [hidden] = aggregateTokens(
      buildInput({
        balances,
        tokens,
        prices,
        overrides: [{ id: position.overrideKey, hidden: 1, updatedAt: Date.now() }],
      }),
    );

    // Keyed by the coin rather than by a contract, so the target cannot move when the balance shifts chains.
    expect(position.overrideKey).toBe('coin:usd-coin');
    expect(hidden.isHidden).toBe(true);
  });

  // A hide recorded before positions had a stable identity was keyed by contract. Ignoring those would
  // silently un-hide everything a user had already dismissed.
  it('still honours a hide recorded under the old per-contract key', () => {
    const [hidden] = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, usdcEthereum, '1000000'), buildBalance(8453, usdcBase, '9000000')],
        tokens: [
          buildToken(1, usdcEthereum, { coingeckoId: 'usd-coin' }),
          buildToken(8453, usdcBase, { coingeckoId: 'usd-coin' }),
        ],
        prices: [{ id: 'coingecko:usd-coin', priceUsd: 1, updatedAt: Date.now() }],
        overrides: [{ id: `8453:${usdcBase}`, hidden: 1, updatedAt: Date.now() }],
      }),
    );

    expect(hidden.isHidden).toBe(true);
    expect(hidden.supersededOverrideKeys).toContain(`8453:${usdcBase}`);
  });
});

describe('aggregateTokens with exchange balances', () => {
  const wethBase = '0x4200000000000000000000000000000000000006';
  const nativeToken = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

  const ethOnBase = () => ({
    balances: [buildBalance(8453, nativeToken, '2000000000000000000')],
    tokens: [buildToken(8453, nativeToken, { symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', name: undefined })],
    prices: [{ id: 'coingecko:ethereum', priceUsd: 3000, updatedAt: Date.now() }],
  });

  // The point of the whole exercise: an exchange is just another place an asset sits, and it joins the row
  // by the same coin id test a second chain has to pass.
  it('merges an exchange holding into the on-chain row for the same coin', () => {
    const [position] = aggregateTokens(
      buildInput({
        ...ethOnBase(),
        exchangeBalances: [buildExchangeBalance('kraken-1', 'ETH', '1')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        exchangeAssetCoingeckoIds: { ETH: 'ethereum' },
      }),
    );

    expect(position.symbol).toBe('ETH');
    expect(position.totalAmount).toBe(3);
    expect(position.valueUsd).toBe(9000);
    expect(position.locations.map((location) => location.kind)).toEqual(['chain', 'exchange']);
  });

  // The headline still reports on-chain and exchange money separately, which it can no longer do by
  // counting rows.
  it('splits a merged row between the chain and exchange totals', () => {
    const tokens = aggregateTokens(
      buildInput({
        ...ethOnBase(),
        exchangeBalances: [buildExchangeBalance('kraken-1', 'ETH', '1')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        exchangeAssetCoingeckoIds: { ETH: 'ethereum' },
      }),
    );

    const totals = calculateTotals(tokens, []);

    expect(totals.tokensUsd).toBe(6000);
    expect(totals.exchangesUsd).toBe(3000);
    // And the money is counted exactly once.
    expect(totals.totalUsd).toBe(9000);
  });

  it('keeps one location per account when an asset sits on two exchanges', () => {
    const [position] = aggregateTokens(
      buildInput({
        exchangeBalances: [
          buildExchangeBalance('kraken-1', 'BTC', '0.5'),
          buildExchangeBalance('coinbase-1', 'BTC', '0.25'),
        ],
        exchangeAccounts: [KRAKEN_ACCOUNT, COINBASE_ACCOUNT],
        exchangeAssetCoingeckoIds: { BTC: 'bitcoin' },
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
      }),
    );

    expect(position.locations).toHaveLength(2);
    expect(position.chainValueUsd).toBe(0);
    expect(position.exchangeValueUsd).toBe(45000);
  });

  // An unresolved ticker is exactly the case the coin id exists to guard: merging on the ticker alone would
  // let an exchange balance land in a row it has nothing to do with.
  it('leaves an asset whose ticker resolves to no coin on its own row', () => {
    const result = aggregateTokens(
      buildInput({
        ...ethOnBase(),
        exchangeBalances: [buildExchangeBalance('kraken-1', 'WHATEVER', '10')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        exchangeAssetCoingeckoIds: {},
        spamSettings: { ...spamSettings, hideUnpricedTokens: false },
      }),
    );

    expect(result).toHaveLength(2);

    const unresolved = result.find((token) => token.symbol === 'WHATEVER')!;
    expect(unresolved.priceUsd).toBeNull();
    expect(unresolved.overrideKey).toBe('exchange:WHATEVER');
  });

  it('takes its symbol and icon from the on-chain holding rather than the exchange ticker', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [buildBalance(8453, wethBase, '1000000000000000000')],
        tokens: [
          buildToken(8453, wethBase, {
            symbol: 'WETH',
            decimals: 18,
            coingeckoId: 'weth',
            logoUrl: 'https://example.test/weth.png',
          }),
        ],
        prices: [{ id: 'coingecko:weth', priceUsd: 3000, updatedAt: Date.now() }],
        exchangeBalances: [buildExchangeBalance('kraken-1', 'WETH', '1')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        exchangeAssetCoingeckoIds: { WETH: 'weth' },
      }),
    );

    expect(position.symbol).toBe('WETH');
    expect(position.logoUrl).toBe('https://example.test/weth.png');
  });

  // Cash on an exchange is part of a portfolio. Without a price it would be filtered away as though it were
  // an unpriced spam airdrop.
  it('values cash balances from the fiat rates', () => {
    const result = aggregateTokens(
      buildInput({
        exchangeBalances: [
          buildExchangeBalance('kraken-1', 'USD', '100'),
          buildExchangeBalance('kraken-1', 'EUR', '100'),
        ],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        fiatRatesPerUsd: { USD: 1, EUR: 0.8 },
      }),
    );

    const dollars = result.find((token) => token.symbol === 'USD')!;
    const euros = result.find((token) => token.symbol === 'EUR')!;

    expect(dollars.valueUsd).toBe(100);
    expect(euros.valueUsd).toBe(125);
  });

  it('never merges cash into a coin that shares its ticker', () => {
    const result = aggregateTokens(
      buildInput({
        exchangeBalances: [buildExchangeBalance('kraken-1', 'EUR', '100')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        // A euro stablecoin claiming the plain EUR ticker must not absorb a cash balance.
        exchangeAssetCoingeckoIds: { EUR: 'some-euro-stablecoin' },
        prices: [{ id: 'coingecko:some-euro-stablecoin', priceUsd: 0.5, updatedAt: Date.now() }],
        fiatRatesPerUsd: { EUR: 0.8 },
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('EUR');
    // Priced as cash from the reference rate, not at the stablecoin's market price.
    expect(result[0].priceUsd).toBe(1.25);
    expect(result[0].valueUsd).toBe(125);
    // The key stays the one the exchange table used, so an existing hide still finds it.
    expect(result[0].overrideKey).toBe('exchange:EUR');
  });

  it('leaves cash unpriced when no rate is available rather than guessing', () => {
    const [position] = aggregateTokens(
      buildInput({
        exchangeBalances: [buildExchangeBalance('kraken-1', 'GBP', '100')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        spamSettings: { ...spamSettings, hideUnpricedTokens: false },
      }),
    );

    expect(position.priceUsd).toBeNull();
    expect(position.valueUsd).toBeNull();
  });

  // The exchange table used to own this decision under its own key. Merging must not lose it.
  it('still honours a hide recorded under the old per-ticker exchange key', () => {
    const [position] = aggregateTokens(
      buildInput({
        ...ethOnBase(),
        exchangeBalances: [buildExchangeBalance('kraken-1', 'ETH', '1')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        exchangeAssetCoingeckoIds: { ETH: 'ethereum' },
        overrides: [{ id: 'exchange:ETH', hidden: 1, updatedAt: Date.now() }],
      }),
    );

    expect(position.isHidden).toBe(true);
    expect(position.hiddenReason).toBe('Hidden by you');
  });
});

describe('aggregateTokens spam and price resolution across a merged row', () => {
  const nativeToken = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const yfiAvalanche = '0x99999999999999999999999999999999999999aa';
  const yfiEthereum = '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e';

  // The heuristics run per contract, so a false positive on one deployment must not take the whole row -
  // and with exchanges merged in, that row can hold money the heuristics never had an opinion about.
  it('does not mark a row spam when only one of its deployments is flagged', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [
          buildBalance(1, yfiEthereum, '1000000000000000000'),
          buildBalance(43114, yfiAvalanche, '1000000000000000'),
        ],
        tokens: [
          buildToken(1, yfiEthereum, { symbol: 'YFI', decimals: 18, coingeckoId: 'yearn-finance' }),
          // The Avalanche deployment tripped the URL heuristic on 'yearn.finance'.
          buildToken(43114, yfiAvalanche, {
            symbol: 'YFI',
            decimals: 18,
            coingeckoId: 'yearn-finance',
            isSpam: 1,
            spamReason: 'Name looks like a website',
          }),
        ],
        prices: [{ id: 'coingecko:yearn-finance', priceUsd: 5000, updatedAt: Date.now() }],
      }),
    );

    expect(position.isSpam).toBe(false);
    expect(position.isHidden).toBe(false);
  });

  // An exchange listing is stronger evidence than a local regex, and hiding the row would take the exchange
  // balance out of the total with it.
  it('does not mark a row spam when the asset is also held on an exchange', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [buildBalance(43114, yfiAvalanche, '1000000000000000')],
        tokens: [
          buildToken(43114, yfiAvalanche, {
            symbol: 'YFI',
            decimals: 18,
            coingeckoId: 'yearn-finance',
            isSpam: 1,
            spamReason: 'Name looks like a website',
          }),
        ],
        prices: [{ id: 'coingecko:yearn-finance', priceUsd: 5000, updatedAt: Date.now() }],
        exchangeBalances: [buildExchangeBalance('kraken-1', 'YFI', '5')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        exchangeAssetCoingeckoIds: { YFI: 'yearn-finance' },
      }),
    );

    expect(position.isSpam).toBe(false);
    expect(position.exchangeValueUsd).toBe(25000);
    expect(calculateTotals([position], []).exchangesUsd).toBe(25000);
  });

  it('still marks a row spam when every deployment of it is', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, yfiEthereum, '1000000000000000000')],
        tokens: [
          buildToken(1, yfiEthereum, { symbol: 'SCAM', decimals: 18, isSpam: 1, spamReason: 'Detected as spam' }),
        ],
      }),
    );

    expect(position.isSpam).toBe(true);
    expect(position.hiddenReason).toBe('Detected as spam');
  });

  // A pool quote is a price for one contract on one chain. When it is all there is, the row must not pick
  // one at random: which position came first depends on the order balances came out of IndexedDB.
  it('prices a row from the largest holding when only pool prices exist', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [
          buildBalance(1, yfiEthereum, '1000000000000000000'),
          buildBalance(43114, yfiAvalanche, '9000000000000000000'),
        ],
        tokens: [
          buildToken(1, yfiEthereum, { symbol: 'TKN', decimals: 18, coingeckoId: 'some-coin' }),
          buildToken(43114, yfiAvalanche, { symbol: 'TKN', decimals: 18, coingeckoId: 'some-coin' }),
        ],
        // No coingecko:some-coin row at all, only per-contract pool prices.
        prices: [
          { id: `1:${yfiEthereum}`, priceUsd: 100, updatedAt: Date.now() },
          { id: `43114:${yfiAvalanche}`, priceUsd: 2, updatedAt: Date.now() },
        ],
      }),
    );

    // Avalanche holds nine of the ten tokens, so its quote is the one that describes the position.
    expect(position.priceUsd).toBe(2);
    expect(position.valueUsd).toBe(20);
  });

  it('prefers the coin price over any pool price', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, nativeToken, '1000000000000000000')],
        tokens: [buildToken(1, nativeToken, { symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum' })],
        prices: [
          { id: `1:${nativeToken}`, priceUsd: 1, updatedAt: Date.now() },
          { id: 'coingecko:ethereum', priceUsd: 3000, updatedAt: Date.now() },
        ],
      }),
    );

    expect(position.priceUsd).toBe(3000);
  });
});

describe('aggregateTokens with manual balances', () => {
  // The payoff of pricing a manual holding by coin id: it is the same asset as the one on the exchange, so
  // it is the same row, with two places listed under it.
  it('merges a manual holding into the row for the same coin', () => {
    const [position] = aggregateTokens(
      buildInput({
        exchangeBalances: [buildExchangeBalance('kraken-1', 'BTC', '0.25')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        exchangeAssetCoingeckoIds: { BTC: 'bitcoin' },
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [buildManualHolding('balance-1', 'BTC', 0.5)],
      }),
    );

    expect(position.symbol).toBe('BTC');
    expect(position.totalAmount).toBe(0.75);
    expect(position.valueUsd).toBe(45000);
    expect(position.locations.map((location) => location.kind)).toEqual(['manual', 'exchange']);
  });

  it('splits the row between the exchange and manual totals', () => {
    const tokens = aggregateTokens(
      buildInput({
        exchangeBalances: [buildExchangeBalance('kraken-1', 'BTC', '0.25')],
        exchangeAccounts: [KRAKEN_ACCOUNT],
        exchangeAssetCoingeckoIds: { BTC: 'bitcoin' },
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [buildManualHolding('balance-1', 'BTC', 0.5)],
      }),
    );

    const totals = calculateTotals(tokens, []);

    expect(totals.exchangesUsd).toBe(15000);
    expect(totals.manualUsd).toBe(30000);
    // And counted exactly once.
    expect(totals.totalUsd).toBe(45000);
  });

  // Two tracked wallets on Ethereum already sum into one Ethereum line, and a hand-entered holding reads the
  // same way: the portfolio answers "how much is on Bitcoin", and the manual balances page answers "in which
  // wallet".
  it('collapses several wallets in one place into a single location', () => {
    const [position] = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [
          buildManualHolding('balance-1', 'BTC', 0.3, { location: 'Bitcoin', wallet: 'Ledger' }),
          buildManualHolding('balance-2', 'BTC', 0.05, { location: 'Bitcoin', wallet: 'Green Wallet' }),
        ],
      }),
    );

    expect(position.locations).toHaveLength(1);
    expect(position.locations[0]).toMatchObject({ kind: 'manual', name: 'Bitcoin', amount: 0.35 });
    expect(position.locations[0].valueUsd).toBe(21000);
  });

  it('keeps holdings in different places apart', () => {
    const [position] = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [
          buildManualHolding('balance-1', 'BTC', 0.3, { location: 'Bitcoin' }),
          buildManualHolding('balance-2', 'BTC', 0.05, { location: 'Cold storage' }),
        ],
      }),
    );

    expect(position.locations.map((location) => location.name).sort()).toEqual(['Bitcoin', 'Cold storage']);
  });

  // Typing the same place two different ways should not split it in two.
  it('matches a place case-insensitively', () => {
    const [position] = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [
          buildManualHolding('balance-1', 'BTC', 0.3, { location: 'Bitcoin' }),
          buildManualHolding('balance-2', 'BTC', 0.05, { location: 'bitcoin' }),
        ],
      }),
    );

    expect(position.locations).toHaveLength(1);
    expect(position.locations[0].amount).toBe(0.35);
  });

  // The page that lists holdings individually prices them by coin, so the row has to say which coin it is.
  it('exposes the coin id it was identified by', () => {
    const [position] = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [buildManualHolding('balance-1', 'BTC', 0.5)],
      }),
    );

    expect(position.coingeckoId).toBe('bitcoin');
  });

  it('names the location the user gave it', () => {
    const [position] = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [buildManualHolding('balance-1', 'BTC', 0.5, { location: 'Cold storage' })],
      }),
    );

    expect(position.locations[0]).toMatchObject({ kind: 'manual', name: 'Cold storage', amount: 0.5 });
  });

  // Two places holding the same coin are two locations on one row, which is the whole reason a manual
  // balance carries a location at all.
  it('keeps two manual holdings of one coin as separate locations', () => {
    const [position] = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [
          buildManualHolding('balance-1', 'BTC', 0.5, { location: 'Ledger' }),
          buildManualHolding('balance-2', 'BTC', 0.25, { location: 'Cold storage' }),
        ],
      }),
    );

    expect(position.locations).toHaveLength(2);
    expect(position.totalAmount).toBe(0.75);
  });

  // Without a price source it can only ever be a quantity, so it must not borrow a value from anywhere.
  it('leaves a holding with no price source unpriced and on its own row', () => {
    const result = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [
          buildManualHolding('balance-1', 'BTC', 0.5),
          buildManualHolding('balance-2', 'RARE', 100, { coingeckoId: undefined }),
        ],
        spamSettings: { ...spamSettings, hideUnpricedTokens: false },
      }),
    );

    const unpriced = result.find((token) => token.symbol === 'RARE')!;
    expect(unpriced.priceUsd).toBeNull();
    expect(unpriced.valueUsd).toBeNull();
    expect(unpriced.overrideKey).toBe('manual:balance-2');
  });

  it('ignores a holding whose ledger nets to zero', () => {
    const result = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [buildManualHolding('balance-1', 'BTC', 0)],
      }),
    );

    expect(result).toHaveLength(0);
  });
});

describe('manual balances and spam', () => {
  const spamToken = '0x00000000000000000000000000000000000000ff';

  // A holding the user typed in themselves is at least as strong a signal as an exchange listing, and
  // hiding the row over a heuristics false positive on a sibling would take that balance out of the total.
  it('does not let a spam-flagged on-chain sibling hide a manual holding', () => {
    const [position] = aggregateTokens(
      buildInput({
        balances: [buildBalance(1, spamToken, '1000000000000000000')],
        tokens: [
          buildToken(1, spamToken, {
            symbol: 'BTC',
            decimals: 18,
            coingeckoId: 'bitcoin',
            isSpam: 1,
            spamReason: 'Name looks like a website',
          }),
        ],
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [buildManualHolding('balance-1', 'BTC', 1)],
      }),
    );

    expect(position.isSpam).toBe(false);
    expect(position.isHidden).toBe(false);
    expect(calculateTotals([position], []).manualUsd).toBe(60000);
  });

  // Summing decimal strings through Number can leave a few atoms behind, and a residue of 1e-17 would show
  // a $0.00 Manual tile for a holding that was fully sold.
  it('ignores a float residue left by a fully sold holding', () => {
    const result = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [buildManualHolding('balance-1', 'BTC', 1e-17)],
      }),
    );

    expect(result).toHaveLength(0);
  });

  it('still counts a genuinely small holding', () => {
    const result = aggregateTokens(
      buildInput({
        prices: [{ id: 'coingecko:bitcoin', priceUsd: 60000, updatedAt: Date.now() }],
        manualHoldings: [buildManualHolding('balance-1', 'BTC', 0.00000001)],
        spamSettings: { ...spamSettings, dustThresholdUsd: 0 },
      }),
    );

    expect(result).toHaveLength(1);
  });
});

describe('aggregateNftCollections', () => {
  const collection = '0x4444444444444444444444444444444444444444';

  const buildNft = (chainId: number, address: string, floorPriceUsd: number | undefined, itemCount: number) => ({
    nftCollections: [
      {
        id: `${chainId}:${address}`,
        chainId,
        address,
        standard: 'erc721' as const,
        name: 'Collection',
        floorPriceUsd,
        metadataUpdatedAt: Date.now(),
      },
    ],
    nftItems: Array.from({ length: itemCount }, (_, index) => ({
      id: `${chainId}:${OWNER}:${address}:${index}`,
      chainId,
      owner: OWNER,
      collection: address,
      tokenId: String(index),
      amount: '1',
      updatedAt: Date.now(),
    })),
  });

  it('hides a collection worth less than the dust threshold', () => {
    const [aggregated] = aggregateNftCollections(buildInput(buildNft(1, collection, 0.2, 2)));

    expect(aggregated.valueUsd).toBeCloseTo(0.4, 8);
    expect(aggregated.isHidden).toBe(true);
    expect(aggregated.hiddenReason).toContain('dust');
  });

  it('keeps a collection worth more than the dust threshold', () => {
    const [aggregated] = aggregateNftCollections(buildInput(buildNft(1, collection, 5, 2)));

    expect(aggregated.isHidden).toBe(false);
  });

  it('hides a collection with no floor price', () => {
    const [aggregated] = aggregateNftCollections(buildInput(buildNft(1, collection, undefined, 2)));

    expect(aggregated.valueUsd).toBeNull();
    expect(aggregated.isHidden).toBe(true);
    expect(aggregated.hiddenReason).toBe('No floor price available');
  });

  // Hiding unpriced collections is governed by the same setting as unpriced tokens, so turning it off brings
  // them back rather than leaving them permanently invisible.
  it('keeps unpriced collections when the setting is off', () => {
    const [aggregated] = aggregateNftCollections({
      ...buildInput(buildNft(1, collection, undefined, 2)),
      spamSettings: { ...spamSettings, hideUnpricedTokens: false },
    });

    expect(aggregated.isHidden).toBe(false);
  });

  it('leaves dust collections out of the total', () => {
    const dust = aggregateNftCollections(buildInput(buildNft(1, collection, 0.2, 2)));
    const real = aggregateNftCollections(buildInput(buildNft(1, collection, 5, 2)));

    expect(calculateTotals([], dust).nftsUsd).toBe(0);
    expect(calculateTotals([], real).nftsUsd).toBe(10);
  });
});

describe('deriveHeldNfts', () => {
  const collection = '0x4444444444444444444444444444444444444444';

  const buildEvent = (overrides: Partial<StoredTransferEvent>): StoredTransferEvent => ({
    id: Math.random().toString(),
    chainId: 1,
    owner: OWNER,
    token: collection,
    standard: 'erc721',
    from: OTHER,
    to: OWNER,
    amount: '1',
    tokenId: '1',
    blockNumber: 1,
    transactionIndex: 0,
    logIndex: 0,
    transactionHash: '0xabc',
    ...overrides,
  });

  it('counts an ERC721 as held when the owner received it last', () => {
    const held = deriveHeldNfts([buildEvent({ blockNumber: 10 })], OWNER as `0x${string}`);

    expect(held).toHaveLength(1);
    expect(held[0].tokenId).toBe('1');
  });

  it('drops an ERC721 that was later sent away', () => {
    const held = deriveHeldNfts(
      [buildEvent({ blockNumber: 10 }), buildEvent({ blockNumber: 20, from: OWNER, to: OTHER })],
      OWNER as `0x${string}`,
    );

    expect(held).toHaveLength(0);
  });

  // Ordering must come from block position, not array order, since logs arrive from several filters.
  it('uses chronological position rather than array order to decide ERC721 ownership', () => {
    const held = deriveHeldNfts(
      [buildEvent({ blockNumber: 20, from: OWNER, to: OTHER }), buildEvent({ blockNumber: 10 })],
      OWNER as `0x${string}`,
    );

    expect(held).toHaveLength(0);
  });

  it('nets inbound and outbound ERC1155 quantities', () => {
    const held = deriveHeldNfts(
      [
        buildEvent({ standard: 'erc1155', amount: '5', blockNumber: 10 }),
        buildEvent({ standard: 'erc1155', amount: '2', blockNumber: 20, from: OWNER, to: OTHER }),
      ],
      OWNER as `0x${string}`,
    );

    expect(held).toHaveLength(1);
    expect(held[0].amount).toBe(3n);
  });

  it('drops an ERC1155 whose quantity nets to zero', () => {
    const held = deriveHeldNfts(
      [
        buildEvent({ standard: 'erc1155', amount: '5', blockNumber: 10 }),
        buildEvent({ standard: 'erc1155', amount: '5', blockNumber: 20, from: OWNER, to: OTHER }),
      ],
      OWNER as `0x${string}`,
    );

    expect(held).toHaveLength(0);
  });
});

describe('classifyTokenSpam', () => {
  it('flags tokens advertising a website', () => {
    expect(classifyTokenSpam({ symbol: 'CLAIM', name: 'Visit reward-site.io', decimals: 18 }).isSpam).toBe(true);
  });

  it('flags airdrop bait wording', () => {
    expect(classifyTokenSpam({ symbol: 'GIFT', name: 'Claim your reward', decimals: 18 }).isSpam).toBe(true);
  });

  it('flags tokens with no readable decimals', () => {
    expect(classifyTokenSpam({ symbol: 'REAL', name: 'Real Token', decimals: undefined }).isSpam).toBe(true);
  });

  // The exact evasion seen in the wild: a domain written with a dot-lookalike, which reads as a URL to a
  // human and matches nothing to a regex looking for a literal ".com".
  it('flags domains hidden behind dot-lookalike characters', () => {
    for (const dot of ['\u2024', '\uFF0E', '\u3002', '\u02D9', '\uA4F8', '\u2E33']) {
      const verdict = classifyTokenSpam({ symbol: 'USDC', name: `USD-SWAP${dot}COM`, decimals: 6 });
      expect(verdict.isSpam, `dot U+${dot.codePointAt(0)?.toString(16)}`).toBe(true);
    }
  });

  it('gives a stable verdict when called repeatedly on the same token', () => {
    const token = { symbol: 'USDC', name: 'USDC-SWAP\u2024XYZ', decimals: 6 };

    // A global regex reused for `test` carries its lastIndex between calls and would alternate here.
    expect([1, 2, 3].map(() => classifyTokenSpam(token).isSpam)).toEqual([true, true, true]);
  });

  it('leaves ordinary tokens alone', () => {
    expect(classifyTokenSpam({ symbol: 'USDC', name: 'USD Coin', decimals: 6 }).isSpam).toBe(false);
    expect(classifyTokenSpam({ symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }).isSpam).toBe(false);
  });
});

describe('normaliseExchangeAsset', () => {
  it('strips Kraken asset class prefixes', () => {
    expect(normaliseExchangeAsset('XXBT')).toBe('BTC');
    expect(normaliseExchangeAsset('ZUSD')).toBe('USD');
    expect(normaliseExchangeAsset('XETH')).toBe('ETH');
  });

  it('maps XBT to BTC', () => {
    expect(normaliseExchangeAsset('XBT')).toBe('BTC');
  });

  // Staked variants are the same underlying asset, so they aggregate with the spot holding.
  it('strips staking suffixes', () => {
    expect(normaliseExchangeAsset('ETH.S')).toBe('ETH');
    expect(normaliseExchangeAsset('DOT.S')).toBe('DOT');
  });

  it('leaves ordinary tickers untouched', () => {
    expect(normaliseExchangeAsset('sol')).toBe('SOL');
  });
});

describe('createEnabledChainFilter', () => {
  it('accepts every supported mainnet chain when the selection is the default', () => {
    const isEnabled = createEnabledChainFilter({ ...DEFAULT_SETTINGS.sync, enabledChainIds: null });

    expect(isEnabled(1)).toBe(true);
    expect(isEnabled(8453)).toBe(true);
  });

  it('excludes testnets from the default selection unless they are turned on', () => {
    expect(createEnabledChainFilter({ ...DEFAULT_SETTINGS.sync, enabledChainIds: null })(11155111)).toBe(false);
    expect(
      createEnabledChainFilter({ ...DEFAULT_SETTINGS.sync, enabledChainIds: null, includeTestnets: true })(11155111),
    ).toBe(true);
  });

  it('accepts only the listed chains once a selection is made', () => {
    const isEnabled = createEnabledChainFilter({ ...DEFAULT_SETTINGS.sync, enabledChainIds: [1, 8453] });

    expect(isEnabled(1)).toBe(true);
    expect(isEnabled(8453)).toBe(true);
    expect(isEnabled(137)).toBe(false);
  });

  // An empty selection is a real choice ("None"), and must not be treated as the "everything" default.
  it('accepts nothing when the selection is empty', () => {
    const isEnabled = createEnabledChainFilter({ ...DEFAULT_SETTINGS.sync, enabledChainIds: [] });

    expect(isEnabled(1)).toBe(false);
  });
});

describe('mergeNativeBalanceSeries', () => {
  // Every ETH rollup reports the coin id 'ethereum'. Assigning instead of summing left the weekly chart
  // showing whichever chain happened to be read last, understating native history by everything else.
  it('sums the same native coin across chains instead of overwriting it', () => {
    const series = new Map<string, { symbol: string; amounts: number[] }>();

    mergeNativeBalanceSeries(series, { coingeckoId: 'ethereum', symbol: 'ETH', amounts: [1, 2, 3] });
    mergeNativeBalanceSeries(series, { coingeckoId: 'ethereum', symbol: 'ETH', amounts: [0.5, 0.5, 0.5] });

    expect(series.get('coingecko:ethereum')?.amounts).toEqual([1.5, 2.5, 3.5]);
  });

  it('keeps different native coins apart', () => {
    const series = new Map<string, { symbol: string; amounts: number[] }>();

    mergeNativeBalanceSeries(series, { coingeckoId: 'ethereum', symbol: 'ETH', amounts: [1] });
    mergeNativeBalanceSeries(series, { coingeckoId: 'binancecoin', symbol: 'BNB', amounts: [7] });

    expect(series.get('coingecko:ethereum')?.amounts).toEqual([1]);
    expect(series.get('coingecko:binancecoin')?.amounts).toEqual([7]);
  });

  // The first series in is copied rather than referenced, so a later merge cannot write back into the
  // caller's array.
  it('does not mutate the series it was given', () => {
    const series = new Map<string, { symbol: string; amounts: number[] }>();
    const first = { coingeckoId: 'ethereum', symbol: 'ETH', amounts: [1, 1] };

    mergeNativeBalanceSeries(series, first);
    mergeNativeBalanceSeries(series, { coingeckoId: 'ethereum', symbol: 'ETH', amounts: [2, 2] });

    expect(first.amounts).toEqual([1, 1]);
  });
});

describe('normaliseExchangeAsset staking variants', () => {
  // Kraken names bonded staking by its bonding period. Leaving the digits attached produces a ticker no
  // price source has heard of, so the holding never merges with the spot balance and shows up unpriced.
  it('strips the bonding period from bonded staking tickers', () => {
    expect(normaliseExchangeAsset('DOT28.S')).toBe('DOT');
    expect(normaliseExchangeAsset('ETH2.S')).toBe('ETH');
    expect(normaliseExchangeAsset('ATOM21.S')).toBe('ATOM');
    expect(normaliseExchangeAsset('SOL03.S')).toBe('SOL');
  });

  it('still strips the plain suffixes', () => {
    expect(normaliseExchangeAsset('ETH.S')).toBe('ETH');
    expect(normaliseExchangeAsset('USDC.M')).toBe('USDC');
    expect(normaliseExchangeAsset('XBT.HOLD')).toBe('BTC');
  });

  // Digits are only part of the suffix, never part of a ticker that stands on its own.
  it('leaves a ticker that genuinely contains digits alone', () => {
    expect(normaliseExchangeAsset('1INCH')).toBe('1INCH');
    expect(normaliseExchangeAsset('ETH2')).toBe('ETH2');
  });
});
