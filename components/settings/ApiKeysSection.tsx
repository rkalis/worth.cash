'use client';

import Card from 'components/ui/Card';
import Input from 'components/ui/Input';
import { useSettings } from 'lib/hooks/useSettings';
import type { ProviderApiKeys } from 'lib/settings/types';
import type { ReactNode } from 'react';

interface KeyDefinition {
  key: keyof ProviderApiKeys;
  label: string;
  placeholder: string;
  hint: ReactNode;
}

const KEY_DEFINITIONS: KeyDefinition[] = [
  {
    key: 'etherscan',
    label: 'Etherscan',
    placeholder: 'Etherscan V2 API key',
    hint: 'One V2 key covers every Etherscan-family explorer. Without it, explorer requests drop to one per five seconds, which is too slow to sync a full history.',
  },
  {
    key: 'coingecko',
    label: 'CoinGecko',
    placeholder: 'Demo or Pro API key',
    hint: 'Used for all prices, including NFT floors. The plan is detected automatically; free and demo plans cap historical data at 365 days and cannot fetch historical NFT floors at all.',
  },
  {
    key: 'opensea',
    label: 'OpenSea',
    placeholder: 'OpenSea API key',
    hint: 'Extends NFT floor prices beyond the ~2,000 collections CoinGecko indexes. Without it, blue-chip collections are still valued via CoinGecko; the long tail is not.',
  },
  {
    key: 'hypersync',
    label: 'HyperSync (Envio)',
    placeholder: 'HyperSync bearer token',
    hint: 'Used for the chains configured to sync through HyperSync. Without a token those chains fall back to their public RPC, which is much slower.',
  },
  {
    key: 'alchemy',
    label: 'Alchemy',
    placeholder: 'Alchemy API key',
    hint: 'Upgrades the RPC endpoint on the many chains whose config prefers Alchemy. Optional, but improves reliability and rate limits.',
  },
  {
    key: 'drpc',
    label: 'dRPC',
    placeholder: 'dRPC API key',
    hint: 'Same as above, for the chains that prefer dRPC.',
  },
  {
    key: 'blockscout',
    label: 'Blockscout',
    placeholder: 'Blockscout API key',
    hint: "Blockscout's hosted API now answers keyless requests with a 402, which is why around 20 chains fail to sync without this. Self-hosted instances are still keyless.",
  },
];

const ApiKeysSection = () => {
  const { settings, updateSettings } = useSettings();

  const setKey = (key: keyof ProviderApiKeys, value: string) => {
    updateSettings({ apiKeys: { ...settings.apiKeys, [key]: value } });
  };

  return (
    <Card title="API keys" bodyClassName="flex flex-col gap-4">
      <p className="text-xs text-zinc-500">
        Every key is optional and stored only in this browser. The app uses whichever data sources the keys you provide
        allow, and degrades rather than failing when one is missing.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {KEY_DEFINITIONS.map((definition) => (
          <Input
            key={definition.key}
            name={`api-key-${definition.key}`}
            label={definition.label}
            placeholder={definition.placeholder}
            hint={definition.hint}
            monospace
            // These are credentials, so they are masked like passwords rather than left in plain sight.
            type="password"
            autoComplete="off"
            value={settings.apiKeys[definition.key] ?? ''}
            onChange={(event) => setKey(definition.key, event.target.value)}
          />
        ))}
      </div>
    </Card>
  );
};

export default ApiKeysSection;
