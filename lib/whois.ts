import { WHOIS_BASE_URL } from 'lib/constants';
import ky from 'lib/ky';
import { mapAsyncBounded } from 'lib/utils/promises';
import { type Address, getAddress } from 'viem';

interface WhoisTokenResponse {
  symbol?: string;
  decimals?: number;
  logoURI?: string;
  isSpam?: boolean;
}

export interface WhoisTokenMetadata {
  symbol?: string;
  decimals?: number;
  logoUrl?: string;
  // A curated verdict, present only when the dataset has an opinion. Distinct from `undefined`, which means
  // the token is simply not in the dataset and the local heuristics still decide.
  isSpam?: boolean;
}

// The outcome of one lookup, as three cases rather than "metadata or nothing". A request that failed is not
// an answer, and a caller that records when it last asked has to be able to tell it apart from "the dataset
// has no entry", or a single outage would read as weeks of confirmed absence.
type WhoisLookup = { status: 'found'; metadata: WhoisTokenMetadata } | { status: 'absent' } | { status: 'failed' };

export interface WhoisChainLookup {
  // Metadata per lowercase address, for the addresses the dataset has an entry for.
  found: Map<string, WhoisTokenMetadata>;
  // Every lowercase address that got a definitive answer, found or absent. An address missing from here was
  // not answered and should be asked about again rather than recorded as checked.
  answered: Set<string>;
}

// How many token lookups run at once. Each is a small static JSON file behind a CDN, so this is about not
// opening a hundred sockets rather than about protecting a rate limit.
const WHOIS_CONCURRENCY = 10;

// Token metadata from the revoke.cash whois dataset.
//
// This is where token logos come from for anything with a contract: an ERC20 exposes a name, a symbol and
// decimals, but no image. CoinGecko's market data covers the rest, which is how an asset held on an
// exchange gets an icon at all, and it stands in for on-chain tokens this dataset has never seen. A token
// neither source knows falls back to its initial on a grey circle. The dataset covers NFT collections too,
// keyed the same way, which is where collection icons come from.
//
// It also carries a curated `isSpam` flag, which is a far better signal than our own name heuristics and is
// trusted over them when present.
const lookupWhoisToken = async (chainId: number, contractAddress: Address): Promise<WhoisLookup> => {
  try {
    // The dataset is keyed by checksummed address. A lowercase address returns an empty object rather than
    // a 404, so getting this wrong looks exactly like "token not in the dataset".
    const url = `${WHOIS_BASE_URL}/tokens/${chainId}/${getAddress(contractAddress)}.json`;
    const response = await ky.get(url, { retry: { limit: 2 } }).json<WhoisTokenResponse>();

    // A token the dataset does not know about is served as `{}` with a 200, so an empty object is the
    // "no data" case rather than an error.
    if (!response || Object.keys(response).length === 0) return { status: 'absent' };

    return {
      status: 'found',
      metadata: {
        symbol: response.symbol,
        decimals: response.decimals,
        logoUrl: response.logoURI,
        isSpam: response.isSpam,
      },
    };
  } catch {
    // A failed lookup is not evidence of anything. It is reported as a failure rather than as absence, so a
    // caller can leave the address unchecked and try again on the next sync.
    return { status: 'failed' };
  }
};

export const fetchWhoisTokenMetadata = async (
  chainId: number,
  contractAddress: Address,
): Promise<WhoisTokenMetadata | undefined> => {
  const lookup = await lookupWhoisToken(chainId, contractAddress);
  return lookup.status === 'found' ? lookup.metadata : undefined;
};

// Looks up many addresses on one chain, reporting which of them actually got an answer.
export const lookupWhoisTokensForChain = async (
  chainId: number,
  contractAddresses: Address[],
): Promise<WhoisChainLookup> => {
  const found = new Map<string, WhoisTokenMetadata>();
  const answered = new Set<string>();
  if (contractAddresses.length === 0) return { found, answered };

  const entries = await mapAsyncBounded(contractAddresses, WHOIS_CONCURRENCY, async (address) => ({
    address: address.toLowerCase(),
    lookup: await lookupWhoisToken(chainId, address),
  }));

  for (const { address, lookup } of entries) {
    if (lookup.status === 'failed') continue;
    answered.add(address);
    if (lookup.status === 'found') found.set(address, lookup.metadata);
  }

  return { found, answered };
};

export const fetchWhoisTokenMetadataForChain = async (
  chainId: number,
  contractAddresses: Address[],
): Promise<Map<string, WhoisTokenMetadata>> => (await lookupWhoisTokensForChain(chainId, contractAddresses)).found;
