import { createViemPublicClientForChain, getChainLogsRpcUrls } from 'lib/chains';
import type { Filter, Log } from 'lib/events';
import { isNullish } from 'lib/utils';
import { isChainHeightError } from 'lib/utils/errors';
import { withRetry, withTimeout } from 'lib/utils/promises';
import { SECOND } from 'lib/utils/time';
import { getAddress, type PublicClient } from 'viem';
import type { LogsProvider } from './LogsProvider';

export class ViemLogsProvider implements LogsProvider {
  private client: PublicClient;

  constructor(
    public chainId: number,
    // A single URL pins the provider to that endpoint. Left unset, it gets the chain's whole list and can
    // fail over, which matters because public RPC lists are full of hosts that are dead or refuse browser
    // requests, and the first entry is not reliably one of the good ones.
    url?: string,
    httpOptions?: { timeout?: number; retryCount?: number },
  ) {
    this.client = createViemPublicClientForChain(chainId, url ?? getChainLogsRpcUrls(chainId), undefined, httpOptions);
  }

  async getLatestBlock(): Promise<number> {
    // Generous enough to let the transport work down its list of endpoints. A tighter bound aborts the whole
    // client while it is still failing over, which looks identical to every endpoint being down.
    return withTimeout(this.client.getBlockNumber().then(Number), 30 * SECOND, 'RPC is unresponsive');
  }

  async getLogs(filter: Filter): Promise<Log[]> {
    // Chain height errors resolve themselves within a block time, so we briefly wait and retry.
    return withRetry(() => this.requestLogs(filter), {
      retries: 2,
      delayMs: 1 * SECOND,
      shouldRetry: isChainHeightError,
    });
  }

  private async requestLogs(filter: Filter): Promise<Log[]> {
    const logs = await this.client.request({
      method: 'eth_getLogs',
      params: [
        { ...filter, fromBlock: `0x${filter.fromBlock.toString(16)}`, toBlock: `0x${filter.toBlock.toString(16)}` },
      ],
    } as any);

    return (logs as any[]).map((log) => this.formatEvent(log)) as Log[];
  }

  private formatEvent(log: any): Log {
    return {
      ...log,
      address: getAddress(log.address),
      blockNumber: Number(log.blockNumber),
      logIndex: Number(log.logIndex),
      transactionIndex: Number(log.transactionIndex),
      timestamp: isNullish(log.blockTimestamp) ? undefined : Number(log.blockTimestamp),
    };
  }
}
