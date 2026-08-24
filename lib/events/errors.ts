import { getChainName } from 'lib/chains';

// Errors here are surfaced verbatim in the sync status list, so they name the chain rather than its id.
// A reader should not have to look up what chain 57073 is to understand what failed.
const describeChain = (chainId: number): string => `${getChainName(chainId as never)} (${chainId})`;

export class LatestBlockUnavailableError extends Error {
  constructor(
    public chainId: number,
    detail?: string,
  ) {
    super(`Could not reach the ${describeChain(chainId)} data source${detail ? `: ${detail}` : ''}`);
    this.name = 'LatestBlockUnavailableError';
  }
}

// The explorer this chain uses requires an API key we do not have. Separated from a generic failure because
// it is the one case the user can actually fix, and the message says how.
export class ExplorerApiKeyRequiredError extends Error {
  constructor(
    public chainId: number,
    public explorer: string,
  ) {
    super(`${describeChain(chainId)} needs a ${explorer} API key, which is not configured in settings`);
    this.name = 'ExplorerApiKeyRequiredError';
  }
}

export class EventLogsUnavailableError extends Error {
  constructor(
    public chainId: number,
    detail?: string,
  ) {
    super(`Could not retrieve event logs for ${describeChain(chainId)}${detail ? `: ${detail}` : ''}`);
    this.name = 'EventLogsUnavailableError';
  }
}

// The explorer's own index is lagging far enough behind the chain head that balances derived from it would
// be silently wrong, so we refuse to sync rather than show stale numbers as if they were current.
export class EventDataSourceOutOfSyncError extends Error {
  constructor(public chainId: number) {
    super(`The ${describeChain(chainId)} data source is still indexing and would return incomplete results`);
    this.name = 'EventDataSourceOutOfSyncError';
  }
}
