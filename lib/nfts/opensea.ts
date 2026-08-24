import { getOpenSeaChainSlug } from 'lib/chains/opensea';
import { coingeckoPriceKey } from 'lib/db/keys';
import ky from 'lib/ky';
import { fetchCoinGeckoIdPrices } from 'lib/prices/current';
import { getRequestQueue } from 'lib/request-queue';
import { SECOND } from 'lib/utils/time';
import type { Address } from 'viem';

interface ContractResponse {
  collection?: string;
}

interface CollectionResponse {
  name?: string;
  image_url?: string;
}

interface StatsResponse {
  total?: {
    floor_price?: number | null;
    floor_price_symbol?: string | null;
  };
}

export interface OpenSeaCollection {
  openseaSlug: string;
  name?: string;
  imageUrl?: string;
  floorPrice?: number;
  floorPriceCurrency?: string;
  floorPriceUsd?: number;
}

// OpenSea's documented limit is 4 requests per second; we stay comfortably under it because a large NFT
// portfolio touches many collections in a single refresh.
const OPENSEA_RATE_LIMIT = { interval: SECOND, intervalCap: 2 };

// Maps the currency a floor price is quoted in to the CoinGecko id used to convert it to USD.
//
// Only OpenSea needs this. CoinGecko's own NFT endpoint returns a USD figure directly, which is one of the
// reasons it is tried first: this table has to be extended by hand every time a new chain appears.
const FLOOR_CURRENCY_COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'weth',
  MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token',
  AVAX: 'avalanche-2',
  APE: 'apecoin',
  SEI: 'sei-network',
  BERA: 'berachain-bera',
  RON: 'ronin',
  FLOW: 'flow',
  KLAY: 'klay-token',
};

// Looks a collection up on OpenSea, given an API key and a chain OpenSea actually covers.
//
// A known slug is reused rather than looked up again, since the contract-to-slug mapping never changes and
// the lookup is a whole extra request.
export const fetchOpenSeaCollection = async (
  chainId: number,
  contractAddress: Address,
  apiKey: string,
  knownSlug?: string,
  needsArtwork = true,
): Promise<OpenSeaCollection | undefined> => {
  const chainSlug = getOpenSeaChainSlug(chainId);
  if (!chainSlug) return undefined;

  const slug =
    knownSlug ??
    (await openSeaRequest<ContractResponse>(
      { operation: 'contract', chain: chainSlug, address: contractAddress },
      apiKey,
    )
      .then((response) => response.collection)
      .catch(() => undefined));

  if (!slug) return undefined;

  const [stats, details] = await Promise.all([
    openSeaRequest<StatsResponse>({ operation: 'stats', slug }, apiKey).catch(() => null),
    needsArtwork
      ? openSeaRequest<CollectionResponse>({ operation: 'collection', slug }, apiKey).catch(() => null)
      : Promise.resolve(null),
  ]);

  const floorPrice = stats?.total?.floor_price ?? undefined;
  const floorPriceCurrency = stats?.total?.floor_price_symbol ?? undefined;

  return {
    openseaSlug: slug,
    name: details?.name,
    imageUrl: details?.image_url,
    floorPrice,
    floorPriceCurrency,
    floorPriceUsd: await convertFloorPriceToUsd(floorPrice, floorPriceCurrency),
  };
};

const convertFloorPriceToUsd = async (
  floorPrice: number | undefined,
  currency: string | undefined,
): Promise<number | undefined> => {
  if (floorPrice === undefined || floorPrice === null) return undefined;

  // OpenSea quotes most floors in the chain's native currency and omits the symbol when it is ETH.
  const coingeckoId = FLOOR_CURRENCY_COINGECKO_IDS[(currency ?? 'ETH').toUpperCase()];
  if (!coingeckoId) return undefined;

  const prices = await fetchCoinGeckoIdPrices([coingeckoId]);
  const currencyPrice = prices.get(coingeckoPriceKey(coingeckoId));

  return currencyPrice ? floorPrice * currencyPrice : undefined;
};

const openSeaRequest = async <T>(body: Record<string, unknown>, apiKey: string): Promise<T> => {
  const queue = getRequestQueue('opensea', OPENSEA_RATE_LIMIT);

  return queue.add(() =>
    ky.post('/api/nfts/opensea', { json: body, headers: { 'x-opensea-key': apiKey }, retry: { limit: 2 } }).json<T>(),
  );
};
