import { HTTPError, type KyInstance } from 'ky';
import {
  getChainApiIdentifer,
  getChainApiKey,
  getChainApiRateLimit,
  getChainApiUrl,
  getChainConfig,
  getChainLogsRpcUrl,
} from 'lib/chains';
import type { Filter, Log } from 'lib/events';
import { EventLogsUnavailableError, ExplorerApiKeyRequiredError, LatestBlockUnavailableError } from 'lib/events/errors';
// Imported from its own module rather than from the providers barrel: the barrel pulls in
// EventGetterLogsProvider, which imports the getters barrel, which imports this file.
import { ViemLogsProvider } from 'lib/events/providers/ViemLogsProvider';
import ky, { kyQueue } from 'lib/ky';
import { getRequestQueue, type RequestQueue } from 'lib/request-queue';
import type { EtherscanPlatform } from 'lib/types';
import { isNullish } from 'lib/utils';
import { isLogResponseSizeError } from 'lib/utils/errors';
import { type Address, getAddress, type Hash, type Hex } from 'viem';
import type { EventGetter } from './EventGetter';

interface LogsResponse {
  status: string;
  message: string;
  result: string | Array<EtherscanLog>;
}

interface EtherscanLog {
  address: Address;
  blockNumber: Hex;
  timeStamp: Hex;
  topics: [topic0: Hex, ...rest: Hex[]];
  data: Hex;
  transactionHash: Hash;
  transactionIndex: Hex;
  logIndex: Hex;
}

interface LatestBlockResponse {
  status: string;
  message: string;
  result: string;
}

// Etherscan caps a single logs response at 1000 entries, which is the signal to narrow the block range.
const ETHERSCAN_MAX_RESULTS = 1000;

export class EtherscanEventGetter implements EventGetter {
  async getLatestBlock(chainId: number): Promise<number> {
    const searchParams = prepareGetLatestBlockQuery(chainId, getChainApiKey(chainId));
    const result = await explorerRequest<LatestBlockResponse>(chainId, { searchParams });

    const blockNumber = Number(result.result);
    if (!blockNumber) throw new LatestBlockUnavailableError(chainId, result.message ?? 'no block number returned');

    return blockNumber;
  }

  async getEvents(chainId: number, filter: Filter): Promise<Log[]> {
    const apiKey = getChainApiKey(chainId);
    const platform = getChainConfig(chainId).getEtherscanCompatiblePlatformNames();

    const searchParams = prepareGetLogsQuery(chainId, filter, apiKey, platform);

    let data: LogsResponse;
    try {
      data = await explorerRequest<LogsResponse>(chainId, { searchParams });
    } catch (error) {
      if (isLogResponseSizeError(error)) throw new Error('Log response size exceeded');
      // A key or connectivity problem is already a precise message; only wrap anything else.
      if (error instanceof ExplorerApiKeyRequiredError || error instanceof LatestBlockUnavailableError) throw error;
      throw new EventLogsUnavailableError(chainId);
    }

    if (typeof data.result === 'string') {
      // A query timeout means the range was too wide, so we signal the caller to split it.
      if (data.result.includes('Query Timeout occurred')) {
        throw new Error('Log response size exceeded');
      }

      // "No records found" is a legitimate empty result rather than a failure.
      if (data.message?.includes('No records found') || data.result.trim() === '') return [];

      throw new EventLogsUnavailableError(chainId, data.result);
    }

    if (typeof data.message === 'string') {
      // Routescan and Snowtrace report a timeout rather than an error when the range is too large.
      const isTimeoutError =
        isNullish(data?.result) &&
        (data.message.includes('Timeout reached') || data.message.includes('Query Timeout occurred'));
      if (isTimeoutError) throw new Error('Log response size exceeded');
    }

    if (!Array.isArray(data.result)) throw new EventLogsUnavailableError(chainId);

    if (data.result.length === ETHERSCAN_MAX_RESULTS) {
      // A single block that still overflows the result cap cannot be split further, so we fall back to a
      // plain RPC call, which generally has no trouble serving one block's worth of logs.
      if (filter.fromBlock === filter.toBlock) {
        const backupLogsProvider = new ViemLogsProvider(chainId, getChainLogsRpcUrl(chainId));
        return await backupLogsProvider.getLogs(filter);
      }

      throw new Error('Log response size exceeded');
    }

    return data.result.map(formatEtherscanEvent);
  }
}

const prepareGetLatestBlockQuery = (chainId: number, apiKey?: string) => {
  const timestamp = Math.floor(Date.now() / 1000);

  const query = {
    chainId: String(chainId),
    module: 'block',
    action: 'getblocknobytime',
    timestamp: String(timestamp),
    closest: 'before',
    apiKey,
  };

  return stripUndefined(query);
};

const prepareGetLogsQuery = (chainId: number, filter: Filter, apiKey?: string, platform?: EtherscanPlatform) => {
  const [topic0, topic1, topic2, topic3] = (filter.topics ?? []).map((topic) =>
    typeof topic === 'string' ? topic.toLowerCase() : topic,
  );

  const query = {
    chainId: String(chainId),
    module: 'logs',
    action: 'getLogs',
    address: filter.address ?? undefined,
    fromBlock: String(filter.fromBlock ?? 0),
    toBlock: String(filter.toBlock ?? 'latest'),
    topic0: topic0 ?? undefined,
    topic1: topic1 ?? undefined,
    topic2: topic2 ?? undefined,
    topic3: topic3 ?? undefined,
    topic0_1_opr: topic0 && topic1 ? 'and' : undefined,
    topic0_2_opr: topic0 && topic2 ? 'and' : undefined,
    topic0_3_opr: topic0 && topic3 ? 'and' : undefined,
    topic1_2_opr: topic1 && topic2 ? 'and' : undefined,
    topic1_3_opr: topic1 && topic3 ? 'and' : undefined,
    topic2_3_opr: topic2 && topic3 ? 'and' : undefined,
    offset: String(ETHERSCAN_MAX_RESULTS),
    page: String(1),
    // Blockscout's Etherscan-compatible API spells the parameter 'apikey' rather than 'apiKey'.
    apiKey: platform?.domain === 'blockscout' ? undefined : apiKey,
    apikey: platform?.domain === 'blockscout' ? apiKey : undefined,
  };

  return stripUndefined(query);
};

const stripUndefined = (query: Record<string, string | undefined>): Record<string, string> => {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => !isNullish(value))) as Record<string, string>;
};

const formatEtherscanEvent = (etherscanLog: EtherscanLog): Log => ({
  address: getAddress(etherscanLog.address),
  topics: etherscanLog.topics.filter((topic: string) => !isNullish(topic)) as [topic0: Hex, ...rest: Hex[]],
  data: etherscanLog.data,
  transactionHash: etherscanLog.transactionHash,
  blockNumber: Number(etherscanLog.blockNumber) || 0,
  transactionIndex: Number(etherscanLog.transactionIndex) || 0,
  logIndex: Number(etherscanLog.logIndex) || 0,
  timestamp: Number(etherscanLog.timeStamp) || undefined,
});

// Clients are cached by API identifier rather than by chain id, because the identifier includes the API key.
// That gives us two things at once: every chain sharing a key queues behind the same rate limit, and editing
// the key in settings transparently produces a fresh client and queue instead of reusing the stale one.
const EXPLORER_CLIENTS = new Map<string, KyInstance>();

const getExplorerClient = (chainId: number): KyInstance => {
  const identifier = getChainApiIdentifer(chainId);

  const existingClient = EXPLORER_CLIENTS.get(identifier);
  if (existingClient) return existingClient;

  const client = createExplorerKy(getRequestQueue(identifier, getChainApiRateLimit(chainId)));
  EXPLORER_CLIENTS.set(identifier, client);
  return client;
};

export const createExplorerKy = (queue: RequestQueue): KyInstance => {
  return ky.extend({
    retry: { limit: 5 },
    fetch: (input, options) => queue.add(() => kyQueue.add(() => fetch(input, options))) as Promise<Response>,
    hooks: {
      afterResponse: [convertRateLimitBodyTo429],
    },
  });
};

// Hosts we have learned cannot be called directly from the page, and must go through our own proxy instead.
//
// Explorer CORS policy is inconsistent even within Blockscout: some instances send `*`, some send only their
// own origin, some send nothing. Rather than encode a guess per chain, the first request to a host finds out
// and every later request to that host skips the doomed direct attempt.
const HOSTS_REQUIRING_PROXY = new Set<string>();

export interface ExplorerRequestOptions {
  searchParams: Record<string, string>;
  // A sub-path under the chain's API base, used by Blockscout's v2 endpoints.
  path?: string;
}

// Performs an explorer API request, transparently falling back to our proxy for hosts that block the browser.
export const explorerRequest = async <T>(chainId: number, options: ExplorerRequestOptions): Promise<T> => {
  const apiUrl = getChainApiUrl(chainId as never);
  if (!apiUrl) throw new LatestBlockUnavailableError(chainId, 'no explorer API is configured');

  const host = new URL(apiUrl).host;

  if (!HOSTS_REQUIRING_PROXY.has(host)) {
    try {
      return await requestDirectly<T>(chainId, apiUrl, options);
    } catch (error) {
      // An HTTP error means the request reached the explorer, so the host is fine and the proxy would not
      // help. Only a network-level failure, which is how the browser reports a CORS block, is worth retrying.
      if (error instanceof HTTPError) throw toExplorerError(chainId, error);
      HOSTS_REQUIRING_PROXY.add(host);
    }
  }

  try {
    return await requestThroughProxy<T>(chainId, options);
  } catch (error) {
    if (error instanceof HTTPError) throw toExplorerError(chainId, error);
    throw error;
  }
};

const requestDirectly = async <T>(chainId: number, apiUrl: string, options: ExplorerRequestOptions): Promise<T> => {
  const url = options.path ? `${apiUrl}${options.path.startsWith('/') ? options.path : `/${options.path}`}` : apiUrl;
  return getExplorerClient(chainId).get(url, { searchParams: options.searchParams }).json<T>();
};

const requestThroughProxy = async <T>(chainId: number, options: ExplorerRequestOptions): Promise<T> => {
  return getExplorerClient(chainId)
    .post('/api/explorer', { json: { chainId, searchParams: options.searchParams, path: options.path } })
    .json<T>();
};

// Turns an HTTP failure into something the user can act on. A 401/402/403 from an explorer means it wants an
// API key, which is the one failure mode they can actually fix, so it must not be reported as a generic
// "could not reach" alongside genuinely dead endpoints.
const toExplorerError = (chainId: number, error: HTTPError): Error => {
  const status = error.response.status;

  if (status === 401 || status === 402 || status === 403) {
    const platform = getChainConfig(chainId).getEtherscanCompatiblePlatformNames();
    const explorerName = platform?.domain === 'blockscout' ? 'Blockscout' : (platform?.domain ?? 'explorer');
    return new ExplorerApiKeyRequiredError(chainId, explorerName);
  }

  return new LatestBlockUnavailableError(chainId, `the explorer returned HTTP ${status}`);
};

// Rate-limit messages are tiny, so anything larger cannot be one. Checking the length first avoids reading
// multi-megabyte log responses a second time just to sniff them.
const RATE_LIMIT_BODY_SNIFF_MAX_BYTES = 4096;

const RATE_LIMIT_BODY_MARKERS = ['max rate limit reached', 'max calls per sec rate limit reached', 'too many requests'];

// Etherscan reports rate limiting as a 200 with an error message in the body, which ky would otherwise treat
// as success. Rewriting it to a 429 lets ky's normal retry-with-backoff handle it.
const convertRateLimitBodyTo429 = async ({ response }: { response: Response }): Promise<Response | undefined> => {
  if (!response.ok) return;

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > RATE_LIMIT_BODY_SNIFF_MAX_BYTES) return;

  const body = await response.clone().text();
  if (body.length > RATE_LIMIT_BODY_SNIFF_MAX_BYTES) return;

  const lowercaseBody = body.toLowerCase();
  if (RATE_LIMIT_BODY_MARKERS.some((marker) => lowercaseBody.includes(marker))) {
    return new Response(body, { status: 429, statusText: 'Too Many Requests', headers: response.headers });
  }
};
