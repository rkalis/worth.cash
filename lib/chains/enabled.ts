import { chainIdSorter, getChainConfigSafe, SUPPORTED_CHAINS } from 'lib/chains';
import type { SyncSettings } from 'lib/settings/types';

// Whether a chain id may count at all: it must still have a supported configuration, and testnets only
// count when they are turned on. Stored data and saved selections can hold ids of chains that have since
// lost support, and those must never count, whichever way the selection is expressed.
const isSelectableChain = (chainId: number, includeTestnets: boolean): boolean => {
  const chain = getChainConfigSafe(chainId);
  if (!chain?.isSupported()) return false;
  return includeTestnets || !chain.isTestnet();
};

// Resolves the configured chain selection to an actual list of chain ids.
//
// `null` means every supported chain, which is the default. An empty array means none, which is a real
// choice the user can make and must not be confused with the default.
export const getEnabledChainIds = (enabledChainIds: number[] | null, includeTestnets: boolean): number[] => {
  const candidates = enabledChainIds ?? SUPPORTED_CHAINS;

  return candidates.filter((chainId) => isSelectableChain(chainId, includeTestnets)).sort(chainIdSorter);
};

// A membership test for filtering already-synced data down to the chains currently enabled.
//
// Disabling a chain hides its data rather than deleting it: the balances, events and NFTs stay in IndexedDB,
// so re-enabling the chain brings everything back instantly instead of forcing a fresh full sync.
export const createEnabledChainFilter = (sync: SyncSettings): ((chainId: number) => boolean) => {
  if (sync.enabledChainIds === null) {
    return (chainId: number) => isSelectableChain(chainId, sync.includeTestnets);
  }

  const enabled = new Set(getEnabledChainIds(sync.enabledChainIds, sync.includeTestnets));
  return (chainId: number) => enabled.has(chainId);
};
