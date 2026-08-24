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

// How many token lookups run at once. Each is a small static JSON file behind a CDN, so this is about not
// opening a hundred sockets rather than about protecting a rate limit.
const WHOIS_CONCURRENCY = 10;

// Token metadata from the revoke.cash whois dataset.
//
// This is where token logos come from for anything with a contract: an ERC20 exposes a name, a symbol and
// decimals, but no image. CoinGecko's market data covers the rest, which is how an asset held on an
// exchange gets an icon at all, and it stands in for on-chain tokens this dataset has never seen. A token
// neither source knows falls back to its initial on a grey circle.
//
// It also carries a curated `isSpam` flag, which is a far better signal than our own name heuristics and is
// trusted over them when present.
export const fetchWhoisTokenMetadata = async (
  chainId: number,
  contractAddress: Address,
): Promise<WhoisTokenMetadata | undefined> => {
  try {
    // The dataset is keyed by checksummed address. A lowercase address returns an empty object rather than
    // a 404, so getting this wrong looks exactly like "token not in the dataset".
    const url = `${WHOIS_BASE_URL}/tokens/${chainId}/${getAddress(contractAddress)}.json`;
    const response = await ky.get(url, { retry: { limit: 2 } }).json<WhoisTokenResponse>();

    // A token the dataset does not know about is served as `{}` with a 200, so an empty object is the
    // "no data" case rather than an error.
    if (!response || Object.keys(response).length === 0) return undefined;

    return {
      symbol: response.symbol,
      decimals: response.decimals,
      logoUrl: response.logoURI,
      isSpam: response.isSpam,
    };
  } catch {
    // A failed lookup is not evidence of anything, and the caller records it as unchecked so the next sync
    // tries again rather than leaving the token permanently without a logo.
    return undefined;
  }
};

export const fetchWhoisTokenMetadataForChain = async (
  chainId: number,
  contractAddresses: Address[],
): Promise<Map<string, WhoisTokenMetadata>> => {
  const resolved = new Map<string, WhoisTokenMetadata>();
  if (contractAddresses.length === 0) return resolved;

  const entries = await mapAsyncBounded(contractAddresses, WHOIS_CONCURRENCY, async (address) => ({
    address: address.toLowerCase(),
    metadata: await fetchWhoisTokenMetadata(chainId, address),
  }));

  for (const entry of entries) {
    if (entry.metadata) resolved.set(entry.address, entry.metadata);
  }

  return resolved;
};
