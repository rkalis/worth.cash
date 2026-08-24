import { ERC20_ABI, ERC20_BYTES32_METADATA_ABI } from 'lib/abis';
import { createViemPublicClientForChain, getChainConfig } from 'lib/chains';
import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import { db } from 'lib/db';
import { tokenKey } from 'lib/db/keys';
import type { StoredToken } from 'lib/db/schema';
import { classifyTokenSpam } from 'lib/portfolio/spam';
import { resolveCoinIdsForTokens } from 'lib/prices/coin-ids';
import { chunkArray } from 'lib/utils';
import { WEEK } from 'lib/utils/time';
import { fetchWhoisTokenMetadataForChain, type WhoisTokenMetadata } from 'lib/whois';
import { type Address, getAddress, type Hex, hexToString, trim } from 'viem';

const METADATA_BATCH_SIZE = 50;

// Token metadata effectively never changes, so we only refresh it when it is this old, and mainly to pick
// up tokens whose calls failed the first time.
const METADATA_MAX_AGE = 4 * WEEK;

// Reads symbol, name, and decimals for every token we hold on this chain but do not yet have metadata for,
// then classifies each one as spam or not.
export const syncTokenMetadata = async (chainId: number, owner: Address): Promise<number> => {
  const balances = await db.balances.where('[chainId+owner]').equals([chainId, owner.toLowerCase()]).toArray();

  const tokenAddresses = balances
    .map((balance) => balance.token)
    .filter((token) => token !== NATIVE_TOKEN_ADDRESS.toLowerCase());

  const existingTokens = await db.tokens.bulkGet(tokenAddresses.map((token) => tokenKey(chainId, token)));
  const staleThreshold = Date.now() - METADATA_MAX_AGE;

  const tokensToFetch = tokenAddresses.filter((_token, index) => {
    const existing = existingTokens[index];
    return !existing || existing.metadataUpdatedAt < staleThreshold;
  });

  // Coin ids and whois data are resolved for every held token, not only the ones being fetched now. Token
  // metadata is refreshed rarely, so tokens stored before either existed would otherwise never pick them up.
  await backfillCoinIds(chainId, tokenAddresses as Address[]);
  await backfillWhoisMetadata(chainId, tokenAddresses as Address[]);

  if (tokensToFetch.length === 0) {
    await ensureNativeTokenRecord(chainId);
    return 0;
  }

  const metadataEntries = await readTokenMetadata(chainId, tokensToFetch as Address[]);

  // The coin id is what the portfolio aggregates on, so it is resolved alongside the on-chain metadata
  // rather than at display time. A token with no coin id is one CoinGecko has never listed, and is treated
  // as its own asset that can never merge with anything else.
  const coinIds = await resolveCoinIdsForTokens(chainId, tokensToFetch as Address[]).catch(() => new Map());

  const whoisEntries = await fetchWhoisTokenMetadataForChain(chainId, tokensToFetch as Address[]).catch(
    () => new Map<string, WhoisTokenMetadata>(),
  );

  // What is already stored, so a refresh can add to it rather than replace it.
  const storedByAddress = new Map(
    existingTokens.filter((token): token is StoredToken => Boolean(token)).map((token) => [token.address, token]),
  );

  const rows: StoredToken[] = metadataEntries.map(({ token, symbol, name, decimals, readFailed }) => {
    const whois = whoisEntries.get(token.toLowerCase());
    const stored = storedByAddress.get(token.toLowerCase());

    // Every field falls back to what we already knew.
    //
    // A refresh reads the chain again, and that read can fail: an RPC outage makes the multicall reject and
    // every field come back undefined. Writing those over a good row would erase the decimals a balance
    // cannot be interpreted without, and the token would drop out of the portfolio entirely until the next
    // refresh four weeks later. A failed read has to leave the row as it found it.
    const resolvedSymbol = symbol ?? whois?.symbol ?? stored?.symbol;
    const resolvedName = name ?? stored?.name;
    const resolvedDecimals = decimals ?? whois?.decimals ?? stored?.decimals;
    const resolvedLogoUrl = whois?.logoUrl ?? stored?.logoUrl;
    const resolvedCoingeckoId = coinIds.get(token.toLowerCase()) ?? stored?.coingeckoId;

    const spamVerdict = resolveSpamVerdict(
      { symbol: resolvedSymbol, name: resolvedName, decimals: resolvedDecimals },
      whois,
    );

    // A failed read leaves the timestamp alone, so the next sync retries instead of treating an RPC outage
    // as a successful refresh and waiting a month. A token that answered with nothing is different: that is
    // a real answer, and re-asking every sync would never produce a better one.

    return {
      id: tokenKey(chainId, token),
      chainId,
      address: token.toLowerCase(),
      standard: 'erc20' as const,
      symbol: resolvedSymbol,
      name: resolvedName,
      decimals: resolvedDecimals,
      logoUrl: resolvedLogoUrl,
      coingeckoId: resolvedCoingeckoId,
      isSpam: spamVerdict.isSpam ? (1 as const) : (0 as const),
      spamReason: spamVerdict.reason,
      whoisCheckedAt: Date.now(),
      metadataUpdatedAt: readFailed ? (stored?.metadataUpdatedAt ?? 0) : Date.now(),
    };
  });

  await db.tokens.bulkPut(rows);
  await ensureNativeTokenRecord(chainId);

  return rows.length;
};

// A curated verdict beats the local heuristics in both directions.
//
// Present and true, the token is spam regardless of how innocuous its name looks. Present and false, the
// token is a known-good listing and must not be hidden by a regex that happens to match its name. Absent,
// the dataset has no opinion and the heuristics decide.
const resolveSpamVerdict = (
  token: Parameters<typeof classifyTokenSpam>[0],
  whois: WhoisTokenMetadata | undefined,
): ReturnType<typeof classifyTokenSpam> => {
  if (whois?.isSpam === true) return { isSpam: true, reason: 'Flagged as spam by the revoke.cash dataset' };
  if (whois?.isSpam === false) return { isSpam: false };
  if (whois) return { isSpam: false };

  return classifyTokenSpam(token);
};

// Fills in whois data for held tokens that have not been looked up yet, so tokens stored before this
// existed pick up their logo without waiting for the monthly metadata refresh.
const backfillWhoisMetadata = async (chainId: number, tokenAddresses: Address[]): Promise<void> => {
  if (tokenAddresses.length === 0) return;

  const stored = await db.tokens.bulkGet(tokenAddresses.map((token) => tokenKey(chainId, token)));
  const staleThreshold = Date.now() - METADATA_MAX_AGE;

  const needsLookup = stored.filter(
    (token) => token && (token.whoisCheckedAt === undefined || token.whoisCheckedAt < staleThreshold),
  );

  if (needsLookup.length === 0) return;

  const whoisEntries = await fetchWhoisTokenMetadataForChain(
    chainId,
    needsLookup.map((token) => token!.address as Address),
  ).catch(() => new Map<string, WhoisTokenMetadata>());

  const updates = needsLookup.map((token) => {
    const whois = whoisEntries.get(token!.address);
    const spamVerdict = resolveSpamVerdict(token!, whois);

    return {
      ...token!,
      logoUrl: whois?.logoUrl ?? token!.logoUrl,
      symbol: token!.symbol ?? whois?.symbol,
      decimals: token!.decimals ?? whois?.decimals,
      isSpam: spamVerdict.isSpam ? (1 as const) : (0 as const),
      spamReason: spamVerdict.reason,
      whoisCheckedAt: Date.now(),
    };
  });

  await db.tokens.bulkPut(updates);
};

// Fills in the coin id for held tokens that do not have one yet. The contract-to-coin-id map is cached
// locally, so this is a lookup rather than a request per token.
const backfillCoinIds = async (chainId: number, tokenAddresses: Address[]): Promise<void> => {
  if (tokenAddresses.length === 0) return;

  const stored = await db.tokens.bulkGet(tokenAddresses.map((token) => tokenKey(chainId, token)));
  const missing = stored.filter((token) => token && !token.coingeckoId);

  if (missing.length === 0) return;

  const coinIds = await resolveCoinIdsForTokens(
    chainId,
    missing.map((token) => token!.address as Address),
  ).catch(() => new Map<string, string>());

  if (coinIds.size === 0) return;

  const updates = missing
    .filter((token) => coinIds.has(token!.address))
    .map((token) => ({ ...token!, coingeckoId: coinIds.get(token!.address) }));

  await db.tokens.bulkPut(updates);
};

interface TokenMetadata {
  token: Address;
  symbol?: string;
  name?: string;
  decimals?: number;
  // True when the chain could not be read at all, as opposed to a token that answered with nothing. The
  // caller has to tell those apart: one must not overwrite what is already stored, the other is the final
  // word on a token that simply has no metadata.
  readFailed?: boolean;
}

const readTokenMetadata = async (chainId: number, tokens: Address[]): Promise<TokenMetadata[]> => {
  const client = createViemPublicClientForChain(chainId);
  const multicallAddress = getChainConfig(chainId).getDeployedContracts()?.multicall3?.address;

  const results: TokenMetadata[] = [];

  for (const batch of chunkArray(tokens, METADATA_BATCH_SIZE)) {
    const contracts = batch.flatMap((token) => [
      { address: getAddress(token), abi: ERC20_ABI, functionName: 'symbol' as const },
      { address: getAddress(token), abi: ERC20_ABI, functionName: 'name' as const },
      { address: getAddress(token), abi: ERC20_ABI, functionName: 'decimals' as const },
    ]);

    const batchResults = await client
      .multicall({ contracts, allowFailure: true, ...(multicallAddress ? { multicallAddress } : {}) })
      .catch(() => null);

    batch.forEach((token, index) => {
      if (!batchResults) {
        results.push({ token, readFailed: true });
        return;
      }

      const symbolResult = batchResults[index * 3];
      const nameResult = batchResults[index * 3 + 1];
      const decimalsResult = batchResults[index * 3 + 2];

      results.push({
        token,
        symbol: readStringResult(symbolResult),
        name: readStringResult(nameResult),
        decimals: decimalsResult?.status === 'success' ? Number(decimalsResult.result) : undefined,
      });
    });

    // Tokens whose string metadata failed to decode may be using the pre-standard bytes32 form (MKR being
    // the canonical example), so those get one focused retry rather than being written off.
    const bytes32Candidates = batch.filter((token) => {
      const entry = results.find((result) => result.token === token);
      return entry && entry.symbol === undefined;
    });

    if (bytes32Candidates.length > 0) {
      await applyBytes32Metadata(chainId, bytes32Candidates, results, multicallAddress);
    }
  }

  return results;
};

const applyBytes32Metadata = async (
  chainId: number,
  tokens: Address[],
  results: TokenMetadata[],
  multicallAddress?: Address,
): Promise<void> => {
  const client = createViemPublicClientForChain(chainId);

  const contracts = tokens.flatMap((token) => [
    { address: getAddress(token), abi: ERC20_BYTES32_METADATA_ABI, functionName: 'symbol' as const },
    { address: getAddress(token), abi: ERC20_BYTES32_METADATA_ABI, functionName: 'name' as const },
  ]);

  const batchResults = await client
    .multicall({ contracts, allowFailure: true, ...(multicallAddress ? { multicallAddress } : {}) })
    .catch(() => null);

  if (!batchResults) return;

  tokens.forEach((token, index) => {
    const entry = results.find((result) => result.token === token);
    if (!entry) return;

    const symbolResult = batchResults[index * 2];
    const nameResult = batchResults[index * 2 + 1];

    entry.symbol = entry.symbol ?? readBytes32Result(symbolResult);
    entry.name = entry.name ?? readBytes32Result(nameResult);
  });
};

const readStringResult = (result: { status: string; result?: unknown } | undefined): string | undefined => {
  if (result?.status !== 'success') return undefined;
  const value = result.result;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const readBytes32Result = (result: { status: string; result?: unknown } | undefined): string | undefined => {
  if (result?.status !== 'success') return undefined;

  try {
    // Trailing zero bytes are padding, not content, so they are trimmed before decoding.
    const decoded = hexToString(trim(result.result as Hex, { dir: 'right' }))
      .replace(/\0/g, '')
      .trim();
    return decoded === '' ? undefined : decoded;
  } catch {
    return undefined;
  }
};

// The native token has no contract to read metadata from, so its record is assembled from the chain config
// and the canonical coin name.
const ensureNativeTokenRecord = async (chainId: number): Promise<void> => {
  const chain = getChainConfig(chainId);
  const id = tokenKey(chainId, NATIVE_TOKEN_ADDRESS);
  const coingeckoId = chain.getNativeTokenCoingeckoId();

  const existing = await db.tokens.get(id);

  // Rewritten when it is missing a name-free record or its coin id, so records written by earlier versions
  // (which stored names like "HyperEVM HYPE") are cleaned up rather than left in place.
  if (existing && existing.name === undefined && existing.coingeckoId === coingeckoId) return;

  await db.tokens.put({
    ...existing,
    id,
    chainId,
    address: NATIVE_TOKEN_ADDRESS,
    standard: 'erc20',
    symbol: chain.getNativeToken(),
    // Native tokens carry no name at all: the UI shows symbols only, and there is nothing to spam-check.
    name: undefined,
    decimals: chain.getNativeTokenDecimals(),
    logoUrl: chain.getLogoUrl(),
    coingeckoId,
    isSpam: 0,
    metadataUpdatedAt: Date.now(),
  });
};
