import { getChainConfig } from 'lib/chains';
import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import { coingeckoPriceKey, exchangeAssetOverrideKey, onChainPriceKey, tokenOverrideKey } from 'lib/db/keys';
import type {
  ExchangeKind,
  StoredBalance,
  StoredCategoryAssignment,
  StoredExchangeAccount,
  StoredExchangeBalance,
  StoredNftCollection,
  StoredNftItem,
  StoredPrice,
  StoredToken,
  StoredTokenOverride,
} from 'lib/db/schema';
import { fiatPriceUsd, isFiatAssetCode } from 'lib/fiat/rates';
import { shortenAddress } from 'lib/format';
import type { ManualHolding } from 'lib/manual/balances';
import type { SpamSettings } from 'lib/settings/types';
import { isNullish } from 'lib/utils';
import { formatUnits } from 'viem';

export interface TokenContractHolding {
  token: string;
  amount: number;
}

interface TokenLocationBase {
  key: string;
  name: string;
  amount: number;
  valueUsd: number | null;
}

export interface TokenChainLocation extends TokenLocationBase {
  kind: 'chain';
  chainId: number;
  // Every contract contributing to this chain's amount. Usually one, but a chain can carry two versions of
  // the same asset (native and bridged USDC being the common case), and collapsing them into a bare total
  // would leave the user unable to tell what was combined.
  contracts: TokenContractHolding[];
}

export interface TokenExchangeLocation extends TokenLocationBase {
  kind: 'exchange';
  accountId: string;
  exchange: ExchangeKind;
  asset: string;
}

// A holding the user recorded by hand, because the app has no way to discover it: a Bitcoin balance, a
// Solana wallet, anything on a chain that is not supported.
export interface TokenManualLocation extends TokenLocationBase {
  kind: 'manual';
}

// Where a holding physically sits. A chain, an exchange account and a balance typed in by hand are the same
// kind of fact about an asset: somewhere it is held. Modelling them as one list is what lets ETH on Base,
// ETH on Kraken and BTC in cold storage be rows of the same shape.
export type TokenLocation = TokenChainLocation | TokenExchangeLocation | TokenManualLocation;

export interface AggregatedToken {
  key: string;
  // Tokens are identified by symbol alone. A name is attacker-controlled metadata, and showing it next to a
  // balance lends an impostor exactly the credibility it is fishing for.
  symbol: string;
  logoUrl?: string;
  // The row a manual show/hide decision is recorded against. Derived from the asset's identity rather than
  // from one of its locations, so the target cannot move when a balance shifts between chains or exchanges.
  overrideKey: string;
  // The coin this row was identified by, when CoinGecko lists it. Exposed so a view that lists holdings
  // individually can price them without re-deriving the identity.
  coingeckoId?: string;
  // Every other key this position could be recorded under: one per contract it is deployed as, one per
  // ticker it trades under. Honoured when reading, and written alongside the primary key so that losing an
  // identity cannot lose the decision.
  supersededOverrideKeys: string[];
  totalAmount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  locations: TokenLocation[];
  // The same value split by where it sits. The summary reports each kind of place separately, and it can no
  // longer get that by counting rows now that one row can span all of them.
  chainValueUsd: number;
  exchangeValueUsd: number;
  manualValueUsd: number;
  isSpam: boolean;
  // The category the user filed this asset under, if any. Resolved through the same keys a hide decision
  // uses, so filing an asset survives its coin id appearing or disappearing.
  categoryId?: string;
  // Whether this position is hidden from the main list, and why. Hidden positions are still returned so the
  // UI can show them in a collapsible section rather than making them vanish.
  isHidden: boolean;
  hiddenReason?: string;
}

export interface AggregatedNftCollection {
  key: string;
  chainId: number;
  chainName: string;
  address: string;
  name: string;
  itemCount: number;
  // Collections are filed by their own key, since a collection has no coin id to be identified by.
  categoryId?: string;
  floorPriceUsd: number | null;
  // Hidden by the same rules as tokens: no price available, or a value below the dust threshold. Hidden
  // collections still appear behind the "show filtered" toggle and count towards nothing.
  isHidden: boolean;
  hiddenReason?: string;
  valueUsd: number | null;
}

export interface PortfolioTotals {
  tokensUsd: number;
  nftsUsd: number;
  exchangesUsd: number;
  manualUsd: number;
  totalUsd: number;
}

export interface AggregationInput {
  balances: StoredBalance[];
  tokens: StoredToken[];
  prices: StoredPrice[];
  overrides: StoredTokenOverride[];
  nftCollections: StoredNftCollection[];
  nftItems: StoredNftItem[];
  exchangeBalances: StoredExchangeBalance[];
  exchangeAccounts: Array<Pick<StoredExchangeAccount, 'id' | 'label' | 'exchange'>>;
  exchangeAssetCoingeckoIds: Record<string, string>;
  // Holdings the user recorded by hand, already reduced to a quantity from their ledger.
  manualHoldings?: ManualHolding[];
  // Logos keyed by CoinGecko coin id, from the market data the exchange pricing already fetches. It is the
  // only icon source for an asset with no contract to look up, which is every exchange-held coin.
  coinLogoUrls?: Record<string, string>;
  // Units of each currency per US dollar, used to value cash held on an exchange.
  fiatRatesPerUsd?: Record<string, number>;
  // Which category the user filed each asset under, keyed by the same identity a hide decision uses.
  categoryAssignments?: StoredCategoryAssignment[];
  spamSettings: SpamSettings;
}

// Builds the portfolio's asset list, merging every place an asset is held into one row.
//
// Identity is CoinGecko's coin id, never the symbol. Deploying a token called USDC costs nothing, so
// grouping on the symbol lets an attacker's airdrop join the row for real USDC and be counted at real
// USDC's price. A coin id comes from CoinGecko's own mapping of coin to deployed contract, so it cannot be
// claimed by an impostor. Anything CoinGecko has never listed gets an identity unique to its own contract
// and is therefore incapable of merging with anything.
//
// That same id is what an exchange balance resolves to, which is why an exchange is just another location:
// the ETH on Kraken and the ETH on Base are the same asset by the same test the chains already had to pass.
export const aggregateTokens = (input: AggregationInput): AggregatedToken[] => {
  const pricesById = new Map(input.prices.map((price) => [price.id, price.priceUsd]));
  const overridesById = new Map(input.overrides.map((override) => [override.id, override.hidden]));
  const categoriesByKey = buildCategoryLookup(input.categoryAssignments);

  const positions = [
    ...buildChainPositions(input, pricesById),
    ...buildExchangePositions(input, pricesById),
    ...buildManualPositions(input, pricesById),
  ];

  const groups = new Map<string, Position[]>();

  for (const position of positions) {
    const group = groups.get(position.identity);
    if (group) {
      group.push(position);
    } else {
      groups.set(position.identity, [position]);
    }
  }

  const aggregated = [...groups.values()].map((cluster) =>
    buildAggregatedToken(cluster, input, overridesById, categoriesByKey),
  );

  return aggregated.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
};

// One holding of one asset in one place, before anything is merged.
interface Position {
  // The grouping key. Positions sharing it are the same asset and are merged into a single row.
  identity: string;
  symbol: string;
  amount: number;
  priceUsd: number | null;
  // Where the price came from. A coin-id price is the market price for the asset and is shared by every
  // holding of it; a pool price is a quote for one specific contract on one specific chain.
  priceSource?: 'coin' | 'pool';
  coingeckoId?: string;
  isSpam: boolean;
  spamReason?: string;
  logoUrl?: string;
  chain?: { chainId: number; chainName: string; token: string };
  exchange?: { accountId: string; accountLabel: string; exchange: ExchangeKind; asset: string };
  manual?: { balanceId: string; location: string; wallet?: string };
}

// Whether there is really anything held, as opposed to a residue.
//
// Summing decimal strings through Number leaves a few atoms behind when a ledger nets to exactly zero, and
// a token contract can report a balance of one wei of something worthless. Neither is a holding, and both
// would otherwise take up a row and a line in a breakdown.
const isRealAmount = (amount: number, spamSettings: SpamSettings): boolean =>
  Number.isFinite(amount) && amount >= spamSettings.dustThresholdAmount && amount > 0;

const buildChainPositions = (input: AggregationInput, pricesById: Map<string, number | null>): Position[] => {
  const tokensById = new Map(input.tokens.map((token) => [token.id, token]));

  // Balances are stored per owner, so two tracked wallets holding the same token on the same chain produce
  // two rows. Summing them here is what makes the portfolio a portfolio rather than a list of wallets; skip
  // it and the same chain appears twice under one asset and the location count counts wallets, not chains.
  const holdingsByToken = new Map<string, { chainId: number; token: string; amount: bigint }>();

  for (const balance of input.balances) {
    const key = `${balance.chainId}:${balance.token}`;
    const existing = holdingsByToken.get(key);

    if (existing) {
      existing.amount += BigInt(balance.amount);
    } else {
      holdingsByToken.set(key, { chainId: balance.chainId, token: balance.token, amount: BigInt(balance.amount) });
    }
  }

  return [...holdingsByToken.values()].flatMap((holding) => {
    const token = tokensById.get(`${holding.chainId}:${holding.token}`);
    const decimals = token?.decimals;

    // Without decimals we cannot turn the raw balance into a real amount, and guessing 18 would invent a
    // number that looks plausible and is wrong.
    if (isNullish(decimals)) return [];

    const amount = Number(formatUnits(holding.amount, decimals));
    if (!isRealAmount(amount, input.spamSettings)) return [];

    const chain = getChainConfig(holding.chainId as never);
    const coingeckoId = resolveCoingeckoId(holding, token);
    const price = resolvePrice(holding, coingeckoId, pricesById);

    return [
      {
        identity: coingeckoId ? `coin:${coingeckoId}` : `contract:${holding.chainId}:${holding.token}`,
        symbol: token?.symbol ?? 'Unknown',
        amount,
        priceUsd: price.priceUsd,
        priceSource: price.source,
        coingeckoId,
        isSpam: token?.isSpam === 1,
        spamReason: token?.spamReason,
        logoUrl: token?.logoUrl,
        chain: {
          chainId: holding.chainId,
          chainName: chain?.getName() ?? `Chain ${holding.chainId}`,
          token: holding.token,
        },
      } satisfies Position,
    ];
  });
};

const buildExchangePositions = (input: AggregationInput, pricesById: Map<string, number | null>): Position[] => {
  const accountsById = new Map(input.exchangeAccounts.map((account) => [account.id, account]));

  return input.exchangeBalances.flatMap((balance) => {
    const amount = Number(balance.amount);
    if (!isRealAmount(amount, input.spamSettings)) return [];

    const asset = balance.asset.toUpperCase();
    const account = accountsById.get(balance.accountId);

    // Cash is checked before the coin id map, so that a euro balance is valued as a euro rather than
    // resolving to whichever token happens to hold the ticker on CoinGecko. It also never merges with a
    // coin, which is what keeps a EUR balance apart from a euro stablecoin.
    const isCash = isFiatAssetCode(asset);
    const coingeckoId = isCash ? undefined : input.exchangeAssetCoingeckoIds[balance.asset];

    const priceUsd = isCash
      ? fiatPriceUsd(asset, input.fiatRatesPerUsd)
      : coingeckoId
        ? (pricesById.get(coingeckoPriceKey(coingeckoId)) ?? null)
        : null;

    return [
      {
        // An asset the symbol map could not resolve has no identity beyond its ticker, so it stays on its
        // own row. Merging on the ticker alone is the exact mistake the coin id exists to prevent.
        identity: coingeckoId ? `coin:${coingeckoId}` : isCash ? `fiat:${asset}` : `exchange:${asset}`,
        symbol: asset,
        amount,
        priceUsd,
        priceSource: 'coin',
        coingeckoId,
        isSpam: false,
        logoUrl: coingeckoId ? input.coinLogoUrls?.[coingeckoId] : undefined,
        exchange: {
          accountId: balance.accountId,
          accountLabel: account?.label ?? balance.accountId,
          // Only used to pick a brand mark, so an account whose row has gone missing simply gets none.
          exchange: account?.exchange ?? 'coinbase',
          asset,
        },
      } satisfies Position,
    ];
  });
};

// Manual holdings price exactly like an exchange holding: by coin id, which is also what merges them into
// the same row as an on-chain or exchange balance of the same asset. One without a coin id keeps an identity
// of its own and can never merge with anything.
const buildManualPositions = (input: AggregationInput, pricesById: Map<string, number | null>): Position[] =>
  (input.manualHoldings ?? []).flatMap((holding) => {
    const { balance, amount } = holding;

    if (!isRealAmount(amount, input.spamSettings)) return [];

    const coingeckoId = balance.coingeckoId;

    return [
      {
        identity: coingeckoId ? `coin:${coingeckoId}` : `manual:${balance.id}`,
        symbol: balance.symbol.toUpperCase(),
        amount,
        priceUsd: coingeckoId ? (pricesById.get(coingeckoPriceKey(coingeckoId)) ?? null) : null,
        priceSource: 'coin',
        coingeckoId,
        isSpam: false,
        logoUrl: coingeckoId ? input.coinLogoUrls?.[coingeckoId] : undefined,
        manual: { balanceId: balance.id, location: balance.location, wallet: balance.wallet },
      } satisfies Position,
    ];
  });

const buildAggregatedToken = (
  cluster: Position[],
  input: AggregationInput,
  overridesById: Map<string, 0 | 1>,
  categoriesByKey: Map<string, string>,
): AggregatedToken => {
  // Every member of a group is the same asset by construction, so they share one price. Crucially this is
  // only ever a price the group's own identity resolved to: nothing inherits a price from a sibling, which
  // is what previously let an unpriced impostor be valued at the real token's price.
  const priceUsd = resolveClusterPrice(cluster);
  const totalAmount = cluster.reduce((total, position) => total + position.amount, 0);
  const valueUsd = isNullish(priceUsd) ? null : totalAmount * priceUsd;

  const locations = buildLocations(cluster, priceUsd);

  const chainValueUsd = sumLocationValues(locations, 'chain');
  const exchangeValueUsd = sumLocationValues(locations, 'exchange');
  const manualValueUsd = sumLocationValues(locations, 'manual');

  // One holding describes the row: its symbol and its icon.
  const primary = pickPrimaryPosition(cluster);
  const spam = resolveClusterSpam(cluster);
  const coingeckoId = cluster.find((position) => position.coingeckoId)?.coingeckoId;

  const overrideKey = resolveOverrideKey(coingeckoId, primary);
  const supersededOverrideKeys = collectSupersededOverrideKeys(cluster, overrideKey);

  const hidden = resolveHiddenState({
    overridesById,
    overrideKey,
    supersededOverrideKeys,
    isSpam: spam.isSpam,
    spamReason: spam.spamReason,
    priceUsd,
    valueUsd,
    spamSettings: input.spamSettings,
  });

  return {
    key: overrideKey,
    symbol: primary.symbol,
    categoryId: resolveCategoryId(categoriesByKey, overrideKey, supersededOverrideKeys),
    logoUrl: primary.logoUrl ?? (coingeckoId ? input.coinLogoUrls?.[coingeckoId] : undefined),
    overrideKey,
    coingeckoId,
    supersededOverrideKeys,
    totalAmount,
    priceUsd,
    valueUsd,
    locations,
    chainValueUsd,
    exchangeValueUsd,
    manualValueUsd,
    isSpam: spam.isSpam,
    ...hidden,
  };
};

// Collapses the cluster into one entry per place: per chain, and per exchange account.
//
// Grouped by chain rather than by contract, because the same coin can be deployed more than once on a chain
// and two rows with the same chain name and nothing to tell them apart reads as a bug.
const buildLocations = (cluster: Position[], priceUsd: number | null): TokenLocation[] => {
  const chainLocations = new Map<number, TokenChainLocation>();
  const exchangeLocations = new Map<string, TokenExchangeLocation>();
  const manualLocations = new Map<string, TokenManualLocation>();

  for (const position of cluster) {
    if (position.chain) {
      const { chainId, chainName, token } = position.chain;
      const existing = chainLocations.get(chainId);

      if (existing) {
        existing.amount += position.amount;
        existing.contracts.push({ token, amount: position.amount });
      } else {
        chainLocations.set(chainId, {
          kind: 'chain',
          key: `chain:${chainId}`,
          chainId,
          name: chainName,
          amount: position.amount,
          valueUsd: null,
          contracts: [{ token, amount: position.amount }],
        });
      }
      continue;
    }

    if (position.manual) {
      const { location } = position.manual;

      // Grouped by where the holding is, not by which of the user's wallets it sits in. Two tracked wallets
      // on Ethereum already sum into one Ethereum line, and a hand-entered holding should read the same way:
      // the portfolio answers "how much is on Bitcoin", and the manual balances page answers "in which
      // wallet". Matched case-insensitively so "Bitcoin" and "bitcoin" do not become two places.
      const groupKey = location.toLowerCase();
      const existing = manualLocations.get(groupKey);

      if (existing) {
        existing.amount += position.amount;
      } else {
        manualLocations.set(groupKey, {
          kind: 'manual',
          key: `manual:${groupKey}`,
          name: location,
          amount: position.amount,
          valueUsd: null,
        });
      }
      continue;
    }

    if (!position.exchange) continue;

    const { accountId, accountLabel, exchange, asset } = position.exchange;
    const existing = exchangeLocations.get(accountId);

    // An exchange can report the same asset more than once for one account, which is what Kraken's staked
    // variants are once their suffix is stripped.
    if (existing) {
      existing.amount += position.amount;
    } else {
      exchangeLocations.set(accountId, {
        kind: 'exchange',
        key: `exchange:${accountId}`,
        accountId,
        exchange,
        asset,
        name: accountLabel,
        amount: position.amount,
        valueUsd: null,
      });
    }
  }

  const locations: TokenLocation[] = [
    ...[...chainLocations.values()].map((location) => ({
      ...location,
      contracts: [...location.contracts].sort((a, b) => b.amount - a.amount),
    })),
    ...exchangeLocations.values(),
    ...manualLocations.values(),
  ].map((location) => ({
    ...location,
    valueUsd: isNullish(priceUsd) ? null : location.amount * priceUsd,
  }));

  return locations.sort((a, b) => {
    const byValue = (b.valueUsd ?? 0) - (a.valueUsd ?? 0);
    if (byValue !== 0) return byValue;

    // Unpriced locations all tie at zero, so a fixed order by kind keeps equal-value places from shuffling.
    if (a.kind !== b.kind) return LOCATION_KIND_ORDER[a.kind] - LOCATION_KIND_ORDER[b.kind];
    return b.amount - a.amount;
  });
};

const LOCATION_KIND_ORDER: Record<TokenLocation['kind'], number> = { chain: 0, exchange: 1, manual: 2 };

const sumLocationValues = (locations: TokenLocation[], kind: TokenLocation['kind']): number =>
  locations
    .filter((location) => location.kind === kind)
    .reduce((total, location) => total + (location.valueUsd ?? 0), 0);

// The price for the whole row.
//
// A coin-id price is the market price for the asset, so every holding of it shares that one number. Only
// when there is none does this fall back to an on-chain pool quote, and then it takes the largest holding's
// rather than whichever position happened to be built first: the row's value must not depend on the order
// balances came out of IndexedDB.
const resolveClusterPrice = (cluster: Position[]): number | null => {
  const coinPrice = cluster.find((position) => position.priceSource === 'coin')?.priceUsd;
  if (!isNullish(coinPrice)) return coinPrice;

  const largestPriced = [...cluster]
    .sort((a, b) => b.amount - a.amount)
    .find((position) => !isNullish(position.priceUsd));

  return largestPriced?.priceUsd ?? null;
};

// Whether the row as a whole is spam.
//
// Spam is a property of a contract, and the heuristics run per contract, so this asks about all of them
// rather than about one chosen holding. A row is spam only when every on-chain deployment of it is: a single
// false positive on a dust balance must not hide the real holdings merged into the same row.
//
// An exchange listing settles it outright, because Kraken and Coinbase do not list airdrop spam. So does a
// manual holding, for a stronger reason: the user typed it in themselves. Either way, hiding the row would
// take that balance out of the total along with it.
const resolveClusterSpam = (cluster: Position[]): { isSpam: boolean; spamReason?: string } => {
  const chainPositions = cluster.filter((position) => position.chain);

  if (chainPositions.length === 0 || cluster.some((position) => position.exchange || position.manual)) {
    return { isSpam: false };
  }

  if (!chainPositions.every((position) => position.isSpam)) return { isSpam: false };

  return { isSpam: true, spamReason: chainPositions.find((position) => position.spamReason)?.spamReason };
};

// Which holding gets to describe the row.
//
// An on-chain holding wins over an exchange one, because a contract carries real metadata where an exchange
// knows only a ticker. Among on-chain holdings, one with a logo wins: having whois metadata at all is also
// what makes its symbol and its spam verdict the trustworthy ones. Value breaks the remaining ties, so the
// answer never depends on iteration order.
const pickPrimaryPosition = (cluster: Position[]): Position => {
  const ranked = [...cluster].sort((a, b) => {
    if (Boolean(a.chain) !== Boolean(b.chain)) return a.chain ? -1 : 1;
    // A manual holding was named by the user, so it describes the row better than an exchange ticker.
    if (Boolean(a.manual) !== Boolean(b.manual)) return a.manual ? -1 : 1;

    const byLogo = Number(Boolean(b.logoUrl)) - Number(Boolean(a.logoUrl));
    if (byLogo !== 0) return byLogo;

    return b.amount * (b.priceUsd ?? 0) - a.amount * (a.priceUsd ?? 0);
  });

  return ranked[0];
};

// The id a show/hide decision is stored under.
//
// A listed coin is keyed by its coin id, which never moves. Everything else keeps the key it has always had:
// an unlisted token by its contract, an unresolved exchange asset by its ticker. That matters because those
// are the positions people actually hide, and rekeying them would silently un-hide every one of them.
const buildCategoryLookup = (assignments: StoredCategoryAssignment[] | undefined): Map<string, string> =>
  new Map((assignments ?? []).map((assignment) => [assignment.id, assignment.categoryId]));

// Filed under the asset's stable identity, and found again under any key it used to have.
//
// Same reasoning as a hide decision: an asset's override key is its coin id when CoinGecko lists it and its
// contract otherwise, and a metadata refresh can move it between the two. Reading through the superseded
// keys as well means filing something under "stablecoins" survives that move rather than silently
// unfiling it.
const resolveCategoryId = (
  categoriesByKey: Map<string, string>,
  overrideKey: string,
  supersededOverrideKeys: string[],
): string | undefined => [overrideKey, ...supersededOverrideKeys].map((key) => categoriesByKey.get(key)).find(Boolean);

const resolveOverrideKey = (coingeckoId: string | undefined, primary: Position): string => {
  if (coingeckoId) return `coin:${coingeckoId}`;
  if (primary.chain) return tokenOverrideKey(primary.chain.chainId, primary.chain.token);
  if (primary.manual) return `manual:${primary.manual.balanceId}`;
  return exchangeAssetOverrideKey(primary.exchange?.asset ?? primary.symbol);
};

// Every key this position could have been hidden under before it had a stable identity: one per contract it
// is deployed as, and one per ticker it trades under.
const collectSupersededOverrideKeys = (cluster: Position[], overrideKey: string): string[] => {
  const keys = cluster.map((position) => {
    if (position.chain) return tokenOverrideKey(position.chain.chainId, position.chain.token);
    if (position.manual) return `manual:${position.manual.balanceId}`;
    return exchangeAssetOverrideKey(position.exchange?.asset ?? position.symbol);
  });

  return [...new Set(keys)].filter((key) => key !== overrideKey);
};

const resolveCoingeckoId = (
  holding: { chainId: number; token: string },
  token: StoredToken | undefined,
): string | undefined =>
  token?.coingeckoId ??
  (holding.token === NATIVE_TOKEN_ADDRESS.toLowerCase()
    ? getChainConfig(holding.chainId as never)?.getNativeTokenCoingeckoId()
    : undefined);

const resolvePrice = (
  holding: { chainId: number; token: string },
  coingeckoId: string | undefined,
  pricesById: Map<string, number | null>,
): { priceUsd: number | null; source?: 'coin' | 'pool' } => {
  // A token CoinGecko has listed is priced by its coin id, which is the market price for that asset rather
  // than whatever a pool on this particular chain happens to quote. Native tokens have no contract at all,
  // so this is the only way to price them.
  if (coingeckoId) {
    const price = pricesById.get(coingeckoPriceKey(coingeckoId));
    if (!isNullish(price)) return { priceUsd: price, source: 'coin' };
  }

  // Everything else falls back to the on-chain pool price for its specific contract, which carries a
  // liquidity floor so that a token quoted against a near-empty pool comes back unpriced rather than cheap.
  const poolPrice = pricesById.get(onChainPriceKey(holding.chainId, holding.token)) ?? null;
  return { priceUsd: poolPrice, source: isNullish(poolPrice) ? undefined : 'pool' };
};

interface HiddenStateInput {
  overridesById: Map<string, 0 | 1>;
  overrideKey: string;
  supersededOverrideKeys: string[];
  isSpam: boolean;
  spamReason?: string;
  priceUsd: number | null;
  valueUsd: number | null;
  spamSettings: SpamSettings;
}

// Decides whether a position is hidden, in the order the user would expect: an explicit choice always wins,
// then automatic spam detection, then the price and dust rules.
const resolveHiddenState = (input: HiddenStateInput): { isHidden: boolean; hiddenReason?: string } => {
  // The identity key is asked first, then the keys this position could have been recorded under before it
  // had one. A write puts the same value in all of them, so they only ever disagree when one was left
  // behind by an older version, and in that case the identity key is the more recent answer.
  const override = [input.overrideKey, ...input.supersededOverrideKeys]
    .map((key) => input.overridesById.get(key))
    .find((value) => value !== undefined);

  if (override === 1) return { isHidden: true, hiddenReason: 'Hidden by you' };
  if (override === 0) return { isHidden: false };

  if (input.spamSettings.useSpamHeuristics && input.isSpam) {
    return { isHidden: true, hiddenReason: input.spamReason ?? 'Detected as spam' };
  }

  if (input.spamSettings.hideUnpricedTokens && isNullish(input.priceUsd)) {
    return { isHidden: true, hiddenReason: 'No price available' };
  }

  if (!isNullish(input.valueUsd) && input.valueUsd < input.spamSettings.dustThresholdUsd) {
    return { isHidden: true, hiddenReason: `Below $${input.spamSettings.dustThresholdUsd} dust threshold` };
  }

  return { isHidden: false };
};

// Groups NFTs by collection. Collections are chain-specific contracts, so the same project deployed on two
// chains is deliberately two entries rather than one.
export const aggregateNftCollections = (input: AggregationInput): AggregatedNftCollection[] => {
  const collectionsById = new Map(input.nftCollections.map((collection) => [collection.id, collection]));
  const categoriesByKey = buildCategoryLookup(input.categoryAssignments);

  const itemsByCollection = new Map<string, StoredNftItem[]>();
  for (const item of input.nftItems) {
    const key = `${item.chainId}:${item.collection}`;
    const items = itemsByCollection.get(key);
    if (items) {
      items.push(item);
    } else {
      itemsByCollection.set(key, [item]);
    }
  }

  const aggregated = [...itemsByCollection.entries()].map(([key, items]) => {
    const collection = collectionsById.get(key);
    const chain = getChainConfig(items[0].chainId as never);

    // ERC1155 holdings count quantities, so an item held five times counts as five.
    const itemCount = items.reduce((total, item) => total + Number(item.amount || '1'), 0);
    const floorPriceUsd = collection?.floorPriceUsd ?? null;
    const valueUsd = isNullish(floorPriceUsd) ? null : floorPriceUsd * itemCount;

    const isUnpriced = isNullish(valueUsd);
    const isBelowDust = !isUnpriced && valueUsd < input.spamSettings.dustThresholdUsd;
    const isHidden = (input.spamSettings.hideUnpricedTokens && isUnpriced) || isBelowDust;

    return {
      key,
      categoryId: categoriesByKey.get(key),
      chainId: items[0].chainId,
      chainName: chain?.getName() ?? `Chain ${items[0].chainId}`,
      address: items[0].collection,
      name: collection?.name ?? collection?.symbol ?? shortenAddress(items[0].collection),
      itemCount,
      floorPriceUsd,
      valueUsd,
      isHidden,
      hiddenReason: isUnpriced
        ? 'No floor price available'
        : isBelowDust
          ? `Below $${input.spamSettings.dustThresholdUsd} dust threshold`
          : undefined,
    };
  });

  return aggregated.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || b.itemCount - a.itemCount);
};

// Only visible positions count towards the totals. A hidden position is one the user has said, directly or
// through their spam settings, is not part of their portfolio, and including it in the headline number
// would contradict the list underneath it.
//
// Tokens and exchanges are split by where the value sits rather than by which list it came from, because a
// single row can now hold both.
export const calculateTotals = (
  tokens: AggregatedToken[],
  nftCollections: AggregatedNftCollection[],
): PortfolioTotals => {
  const visibleTokens = tokens.filter((token) => !token.isHidden);

  const tokensUsd = visibleTokens.reduce((total, token) => total + token.chainValueUsd, 0);
  const exchangesUsd = visibleTokens.reduce((total, token) => total + token.exchangeValueUsd, 0);
  const manualUsd = visibleTokens.reduce((total, token) => total + token.manualValueUsd, 0);

  const nftsUsd = nftCollections
    .filter((collection) => !collection.isHidden)
    .reduce((total, collection) => total + (collection.valueUsd ?? 0), 0);

  return { tokensUsd, nftsUsd, exchangesUsd, manualUsd, totalUsd: tokensUsd + nftsUsd + exchangesUsd + manualUsd };
};
