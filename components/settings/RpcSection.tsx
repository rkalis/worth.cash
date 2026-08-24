'use client';

import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import ChainLogo from 'components/ui/ChainLogo';
import Input from 'components/ui/Input';
import { chainIdSorter, getChainName, SUPPORTED_CHAINS } from 'lib/chains';
import { useSettings } from 'lib/hooks/useSettings';
import { useMemo, useState } from 'react';

// Custom RPC endpoints, one per chain.
//
// Two things need these. Syncing a long history reads a lot of logs, and a paid endpoint has the rate
// limits to do that quickly. Reconstructing a past point additionally needs historical state, which only an
// archive node can serve, so a chain on a pruning public RPC will be missing its native balance history.
const RpcSection = () => {
  const { settings, updateSettings } = useSettings();
  const [chainQuery, setChainQuery] = useState('');
  const [rpcUrl, setRpcUrl] = useState('');
  const [selectedChainId, setSelectedChainId] = useState<number>();
  const [error, setError] = useState<string>();

  const overrides = Object.entries(settings.rpcOverrides).map(([chainId, url]) => ({
    chainId: Number(chainId),
    url,
  }));

  const matchingChains = useMemo(() => {
    const query = chainQuery.trim().toLowerCase();
    if (!query) return [];

    return [...SUPPORTED_CHAINS]
      .sort(chainIdSorter)
      .map((chainId) => ({ chainId, name: getChainName(chainId as never) }))
      .filter((entry) => entry.name.toLowerCase().includes(query) || String(entry.chainId).includes(query))
      .slice(0, 6);
  }, [chainQuery]);

  const addOverride = () => {
    setError(undefined);

    if (!selectedChainId) {
      setError('Pick a chain first');
      return;
    }

    try {
      const parsed = new URL(rpcUrl.trim());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        setError('The RPC URL must be http or https');
        return;
      }
    } catch {
      setError('That is not a valid URL');
      return;
    }

    updateSettings({ rpcOverrides: { ...settings.rpcOverrides, [selectedChainId]: rpcUrl.trim() } });
    setChainQuery('');
    setRpcUrl('');
    setSelectedChainId(undefined);
  };

  const removeOverride = (chainId: number) => {
    const next = { ...settings.rpcOverrides };
    delete next[chainId];
    updateSettings({ rpcOverrides: next });
  };

  return (
    <Card title="Custom RPC endpoints" bodyClassName="flex flex-col gap-4">
      <p className="text-xs text-zinc-500">
        A custom endpoint replaces the built-in one for that chain. Worth setting where you have a paid endpoint, and
        required for historical balance charts, since reconstructing past native balances needs an archive node that
        most public RPCs are not.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Input
            name="rpc-chain"
            label="Chain"
            placeholder="Search by name or chain id"
            value={selectedChainId ? getChainName(selectedChainId as never) : chainQuery}
            onChange={(event) => {
              setSelectedChainId(undefined);
              setChainQuery(event.target.value);
            }}
          />

          {!selectedChainId && matchingChains.length > 0 ? (
            <ul className="mt-1 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
              {matchingChains.map((entry) => (
                <li key={entry.chainId}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedChainId(entry.chainId);
                      setChainQuery('');
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  >
                    <ChainLogo chainId={entry.chainId} size={14} />
                    <span className="truncate">{entry.name}</span>
                    <span className="ml-auto text-zinc-400">{entry.chainId}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <Input
          name="rpc-url"
          label="RPC URL"
          placeholder="https://..."
          monospace
          value={rpcUrl}
          error={error}
          onChange={(event) => setRpcUrl(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && addOverride()}
        />
      </div>

      <div>
        <Button variant="primary" onClick={addOverride} disabled={!rpcUrl.trim() || !selectedChainId}>
          Save endpoint
        </Button>
      </div>

      {overrides.length > 0 ? (
        <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {overrides.map((override) => (
            <li key={override.chainId} className="flex items-center gap-3 py-2.5">
              <ChainLogo chainId={override.chainId} size={16} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{getChainName(override.chainId as never)}</div>
                <div className="font-mono text-[11px] text-zinc-500 truncate">{override.url}</div>
              </div>
              <Button variant="danger" size="sm" onClick={() => removeOverride(override.chainId)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
};

export default RpcSection;
