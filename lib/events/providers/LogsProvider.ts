import type { Filter, Log } from 'lib/events';

// The latest block must come from the same source as the logs. Mixing sources (for example asking a node
// for the head and then asking Etherscan for the logs) records a sync cursor for a block the log source has
// not indexed yet, which silently drops every transfer in between.
export interface LogsProvider {
  chainId: number;
  getLatestBlock(): Promise<number>;
  getLogs(filter: Filter): Promise<Array<Log>>;
}
