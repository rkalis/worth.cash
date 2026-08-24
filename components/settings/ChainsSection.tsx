'use client';

import Badge from 'components/ui/Badge';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import ChainLogo from 'components/ui/ChainLogo';
import Input from 'components/ui/Input';
import Toggle from 'components/ui/Toggle';
import { chainIdSorter, getChainConfig, getChainName, SUPPORTED_CHAINS } from 'lib/chains';
import { useSettings } from 'lib/hooks/useSettings';
import { cn } from 'lib/utils/classnames';
import { useMemo, useState } from 'react';

// A pragmatic default for people who do not want to wait out a first sync across every supported chain.
// Roughly the chains that hold the overwhelming majority of real balances.
const MAJOR_CHAIN_IDS = [
  1, 56, 8453, 42161, 10, 43114, 137, 100, 59144, 534352, 324, 81457, 5000, 130, 42220, 1868, 7777777, 34443,
];

const ChainsSection = () => {
  const { settings, updateSettings } = useSettings();
  const [filter, setFilter] = useState('');

  const allChains = useMemo(() => {
    return [...SUPPORTED_CHAINS]
      .sort(chainIdSorter)
      .map((chainId) => ({ chainId, name: getChainName(chainId as never), chain: getChainConfig(chainId as never) }))
      .filter((entry) => settings.sync.includeTestnets || !entry.chain.isTestnet());
  }, [settings.sync.includeTestnets]);

  const filteredChains = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return allChains;
    return allChains.filter(
      (entry) => entry.name.toLowerCase().includes(query) || String(entry.chainId).includes(query),
    );
  }, [allChains, filter]);

  // `null` means every supported chain, which is the default and what an empty selection would otherwise be
  // ambiguous about.
  const enabledChainIds = settings.sync.enabledChainIds;
  const isChainEnabled = (chainId: number) => enabledChainIds === null || enabledChainIds.includes(chainId);

  const toggleChain = (chainId: number) => {
    const current = enabledChainIds ?? allChains.map((entry) => entry.chainId);
    const next = current.includes(chainId) ? current.filter((id) => id !== chainId) : [...current, chainId];

    updateSettings({ sync: { ...settings.sync, enabledChainIds: next } });
  };

  const enabledCount = enabledChainIds === null ? allChains.length : enabledChainIds.length;

  return (
    <Card
      title={`Chains (${enabledCount} of ${allChains.length})`}
      bodyClassName="flex flex-col gap-4"
      action={
        <div className="flex gap-1">
          <Button
            variant="tertiary"
            size="sm"
            onClick={() => updateSettings({ sync: { ...settings.sync, enabledChainIds: null } })}
          >
            All
          </Button>
          <Button
            variant="tertiary"
            size="sm"
            onClick={() => updateSettings({ sync: { ...settings.sync, enabledChainIds: MAJOR_CHAIN_IDS } })}
          >
            Majors only
          </Button>
          <Button
            variant="tertiary"
            size="sm"
            onClick={() => updateSettings({ sync: { ...settings.sync, enabledChainIds: [] } })}
          >
            None
          </Button>
        </div>
      }
    >
      <p className="text-xs text-zinc-500">
        Every supported chain is synced by default. A first sync across all of them takes a long time and uses a lot of
        API quota, because each chain's full transfer history has to be read once. After that, syncing is incremental
        and fast.
      </p>

      <p className="text-xs text-zinc-500">
        Disabling a chain hides everything already synced from it as well as stopping future syncs. Nothing is deleted,
        so re-enabling a chain brings its balances straight back without syncing again.
      </p>

      <Toggle
        label="Skip chains with no account activity"
        description="Skips reading a chain's history when the address has never sent a transaction there and holds none of its native token. A large speed-up on a first sync. Turn it off if you track an address that only ever received tokens and never transacted."
        checked={settings.sync.skipInactiveChains}
        onChange={(checked) => updateSettings({ sync: { ...settings.sync, skipInactiveChains: checked } })}
      />

      <Toggle
        label="Include testnets"
        description="Testnet balances have no real value, so they are excluded by default."
        checked={settings.sync.includeTestnets}
        onChange={(checked) => updateSettings({ sync: { ...settings.sync, includeTestnets: checked } })}
      />

      <div className="max-w-48">
        <Input
          name="chain-concurrency"
          label="Chains synced at once"
          type="number"
          min={1}
          max={16}
          hint="Higher is faster but more likely to hit provider rate limits."
          value={settings.sync.chainConcurrency}
          onChange={(event) =>
            updateSettings({
              sync: { ...settings.sync, chainConcurrency: Math.min(16, Math.max(1, Number(event.target.value) || 1)) },
            })
          }
        />
      </div>

      <Input
        name="chain-filter"
        placeholder="Search chains"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />

      <div className="grid gap-1 sm:grid-cols-2 max-h-80 overflow-y-auto">
        {filteredChains.map((entry) => {
          const isEnabled = isChainEnabled(entry.chainId);

          return (
            <button
              key={entry.chainId}
              type="button"
              // The visible label lives in a child span, which leaves the button itself unnamed for screen
              // readers and for anything else driving the page by accessible name.
              aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${entry.name}`}
              aria-pressed={isEnabled}
              onClick={() => toggleChain(entry.chainId)}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                isEnabled ? 'bg-zinc-50 dark:bg-zinc-900/60' : 'opacity-45 hover:opacity-80',
              )}
            >
              <input
                type="checkbox"
                checked={isEnabled}
                readOnly
                tabIndex={-1}
                aria-hidden
                className="size-3.5 accent-black dark:accent-white pointer-events-none"
              />
              <ChainLogo chainId={entry.chainId} size={16} />
              <span className="text-xs truncate flex-1">{entry.name}</span>
              <Badge>{entry.chain.type.toLowerCase()}</Badge>
            </button>
          );
        })}
      </div>
    </Card>
  );
};

export default ChainsSection;
