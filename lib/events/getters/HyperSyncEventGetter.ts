import type { Filter, Log } from 'lib/events';
import { EventLogsUnavailableError, LatestBlockUnavailableError } from 'lib/events/errors';
import ky from 'lib/ky';
import { getApiKey } from 'lib/settings/runtime';
import type { Hex } from 'viem';

interface HyperSyncLogsResponse {
  logs: Log[];
}

interface HyperSyncHeightResponse {
  height: number;
}

// HyperSync is reached through our own route handler rather than directly.
//
// The `@envio-dev/hypersync-client` package is a native Node addon, so it cannot run in the browser where the
// rest of the sync lives. The route handler at app/api/logs/hypersync is a thin proxy around it, and the
// user's HyperSync token travels with each request instead of being read from the server's environment.
export class HyperSyncEventGetter {
  async getLatestBlock(chainId: number): Promise<number> {
    try {
      const response = await ky
        .post('/api/logs/hypersync', { json: { action: 'height', chainId }, headers: this.getHeaders() })
        .json<HyperSyncHeightResponse>();

      if (!response.height) throw new LatestBlockUnavailableError(chainId);
      return response.height;
    } catch (error) {
      if (error instanceof LatestBlockUnavailableError) throw error;
      throw new LatestBlockUnavailableError(chainId);
    }
  }

  async getEvents(chainId: number, filter: Filter): Promise<Log[]> {
    const response = await ky
      .post('/api/logs/hypersync', {
        json: { action: 'logs', chainId, filter: serializeFilter(filter) },
        headers: this.getHeaders(),
      })
      .json<HyperSyncLogsResponse>()
      .catch((error) => {
        // The route handler forwards HyperSync's own message, which the divide-and-conquer logic inspects to
        // decide whether to narrow the range, so it must not be swallowed here.
        throw error instanceof Error ? error : new EventLogsUnavailableError(chainId);
      });

    return response.logs;
  }

  private getHeaders(): Record<string, string> {
    const apiKey = getApiKey('hypersync');
    return apiKey ? { 'x-hypersync-key': apiKey } : {};
  }
}

// HyperSync rejects `null` as a topic and expects an empty array to mean "any value" instead.
const serializeFilter = (filter: Filter) => ({
  fromBlock: filter.fromBlock,
  toBlock: filter.toBlock,
  address: filter.address,
  topics: filter.topics.map((topic) => (topic ? [topic as Hex] : [])),
});
