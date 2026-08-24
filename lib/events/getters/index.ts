import { type DocumentedChainId, getChainConfig } from 'lib/chains';
import { SupportType } from 'lib/chains/Chain';
import { getApiKey } from 'lib/settings/runtime';
import { singleton } from 'lib/utils';
import { BlockScoutEventGetter } from './BlockScoutEventGetter';
import { EtherscanEventGetter } from './EtherscanEventGetter';
import type { EventGetter } from './EventGetter';
import { HyperSyncEventGetter } from './HyperSyncEventGetter';
import { NodeEventGetter } from './NodeEventGetter';
import { RoutescanEventGetter } from './RoutescanEventGetter';

export type { EventGetter } from './EventGetter';

// Getters are stateful (they own client and rate-limit caches), so there is exactly one of each. The
// singleton wrapper keeps construction lazy so importing this module has no side effects.
const EVENT_GETTERS: Record<SupportType, () => EventGetter | undefined> = {
  [SupportType.PROVIDER]: singleton(() => new NodeEventGetter()),
  [SupportType.HYPERSYNC]: singleton(() => new HyperSyncEventGetter()),
  [SupportType.ETHERSCAN]: singleton(() => new EtherscanEventGetter()),
  [SupportType.BLOCKSCOUT]: singleton(() => new BlockScoutEventGetter()),
  [SupportType.ROUTESCAN]: singleton(() => new RoutescanEventGetter()),
  [SupportType.UNSUPPORTED]: () => undefined,
};

export const getEventGetter = (chainId: DocumentedChainId): EventGetter => {
  const supportType = getChainConfig(chainId).type;

  // HyperSync serves keyless requests, but at a rate limit too low to sync a full history with. Without a
  // token we would rather go straight to the chain's RPC than crawl.
  if (supportType === SupportType.HYPERSYNC && !getApiKey('hypersync')) {
    return EVENT_GETTERS[SupportType.PROVIDER]()!;
  }

  const eventGetter = EVENT_GETTERS[supportType]();

  if (!eventGetter) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  return eventGetter;
};
