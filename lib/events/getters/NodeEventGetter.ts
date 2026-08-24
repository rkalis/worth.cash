import { getChainLogsRpcUrl } from 'lib/chains';
import type { Filter, Log } from 'lib/events';
import { DivideAndConquerLogsProvider } from 'lib/events/providers/DivideAndConquerLogsProvider';
// Imported from the concrete modules rather than the providers barrel, which would import the getters
// barrel and form a cycle back to this file.
import type { LogsProvider } from 'lib/events/providers/LogsProvider';
import { ViemLogsProvider } from 'lib/events/providers/ViemLogsProvider';
import type { EventGetter } from './EventGetter';

// Reads logs straight from the chain's RPC. This is the highest quality source when the chain has an RPC
// that serves historical logs, since it needs no third-party indexer and no API key.
export class NodeEventGetter implements EventGetter {
  private logsProviders = new Map<number, LogsProvider>();

  private getLogsProvider(chainId: number): LogsProvider {
    const existingProvider = this.logsProviders.get(chainId);
    if (existingProvider) return existingProvider;

    const provider = new DivideAndConquerLogsProvider(new ViemLogsProvider(chainId, getChainLogsRpcUrl(chainId)));
    this.logsProviders.set(chainId, provider);
    return provider;
  }

  async getLatestBlock(chainId: number): Promise<number> {
    return this.getLogsProvider(chainId).getLatestBlock();
  }

  async getEvents(chainId: number, filter: Filter): Promise<Log[]> {
    return this.getLogsProvider(chainId).getLogs(filter);
  }
}
