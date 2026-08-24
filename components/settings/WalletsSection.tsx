'use client';

import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import Input from 'components/ui/Input';
import { formatRelativeTime } from 'lib/format';
import { useWallets } from 'lib/hooks/useWallets';
import { useState } from 'react';
import { getAddress } from 'viem';

const WalletsSection = () => {
  const { wallets, addWallet, removeWallet, setWalletEnabled, setWalletLabel } = useWallets();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();

  const submit = async () => {
    setError(undefined);
    try {
      await addWallet(address, label);
      setAddress('');
      setLabel('');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  return (
    <Card title="Wallets" bodyClassName="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <div className="flex-1">
          <Input
            label="EVM address"
            name="wallet-address"
            placeholder="0x..."
            monospace
            value={address}
            error={error}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
          />
        </div>
        <div className="sm:w-44">
          <Input
            label="Label (optional)"
            name="wallet-label"
            placeholder="Main wallet"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
          />
        </div>
        <Button variant="primary" onClick={submit} disabled={!address.trim()}>
          Add
        </Button>
      </div>

      {wallets.length === 0 ? (
        <p className="text-xs text-zinc-500">No wallets tracked yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {wallets.map((wallet) => (
            <li key={wallet.address} className="flex items-center gap-3 py-2.5">
              <input
                type="checkbox"
                checked={wallet.enabled === 1}
                aria-label={`Include ${wallet.label ?? wallet.address} in syncs`}
                onChange={(event) => setWalletEnabled(wallet.address, event.target.checked)}
                className="size-4 accent-black dark:accent-white"
              />

              <div className="min-w-0 flex-1">
                <input
                  value={wallet.label ?? ''}
                  placeholder="Add a label"
                  aria-label={`Label for ${wallet.address}`}
                  onChange={(event) => setWalletLabel(wallet.address, event.target.value)}
                  className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-zinc-400 placeholder:font-normal"
                />
                <div className="font-mono text-[11px] text-zinc-500 truncate">{getAddress(wallet.address)}</div>
              </div>

              <span className="text-[11px] text-zinc-400 shrink-0 hidden sm:block">
                added {formatRelativeTime(wallet.addedAt)}
              </span>

              <Button variant="danger" size="sm" onClick={() => removeWallet(wallet.address)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

export default WalletsSection;
