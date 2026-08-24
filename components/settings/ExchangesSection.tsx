'use client';

import Badge from 'components/ui/Badge';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import Input from 'components/ui/Input';
import type { ExchangeKind } from 'lib/db/schema';
import { useExchangeAccounts } from 'lib/hooks/useExchangeAccounts';
import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

const ExchangesSection = () => {
  const { accounts, addAccount, removeAccount, setAccountEnabled } = useExchangeAccounts();

  const [exchange, setExchange] = useState<ExchangeKind>('coinbase');
  const [label, setLabel] = useState('');
  const [keyName, setKeyName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [error, setError] = useState<string>();

  const isCoinbase = exchange === 'coinbase';

  const submit = async () => {
    setError(undefined);
    try {
      await addAccount({
        exchange,
        label,
        // Coinbase identifies the key by its full CDP name; Kraken uses a plain key id.
        apiKey: isCoinbase ? keyName : apiKey,
        apiSecret,
        keyName: isCoinbase ? keyName : undefined,
      });

      setLabel('');
      setKeyName('');
      setApiKey('');
      setApiSecret('');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  return (
    <Card title="Exchange accounts" bodyClassName="flex flex-col gap-4">
      <p className="text-xs text-zinc-500">
        Use read-only keys. Requests are signed by this app's own server route because both exchanges require a
        signature that cannot be produced in the browser, and the credentials are sent with each request rather than
        stored on the server.
      </p>

      <div className="flex gap-1">
        {(['coinbase', 'kraken'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setExchange(option)}
            className={cn(
              'px-3 h-8 rounded-lg text-sm border transition-colors',
              exchange === option
                ? 'border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-900 font-medium'
                : 'border-transparent text-zinc-500 hover:text-black dark:hover:text-white',
            )}
          >
            {option === 'coinbase' ? 'Coinbase' : 'Kraken'}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          name="exchange-label"
          label="Label"
          placeholder={isCoinbase ? 'Coinbase' : 'Kraken'}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />

        {isCoinbase ? (
          <Input
            name="coinbase-key-name"
            label="Key name"
            placeholder="organizations/{org_id}/apiKeys/{key_id}"
            hint="The full key name from the CDP portal, not just the key id."
            monospace
            value={keyName}
            onChange={(event) => setKeyName(event.target.value)}
          />
        ) : (
          <Input
            name="kraken-api-key"
            label="API key"
            placeholder="Kraken API key"
            monospace
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        )}

        <div className="sm:col-span-2">
          <Input
            name="exchange-secret"
            label={isCoinbase ? 'Private key' : 'Private key (API secret)'}
            placeholder={
              isCoinbase ? '-----BEGIN EC PRIVATE KEY----- ... or a base64 Ed25519 key' : 'Base64 encoded secret'
            }
            hint={
              isCoinbase
                ? 'Both CDP key formats are supported: an EC private key in PEM form, or a base64 Ed25519 key.'
                : 'The base64 private key Kraken shows once when you create the key.'
            }
            monospace
            type="password"
            autoComplete="off"
            value={apiSecret}
            error={error}
            onChange={(event) => setApiSecret(event.target.value)}
          />
        </div>
      </div>

      <div>
        <Button
          variant="primary"
          onClick={submit}
          disabled={!apiSecret.trim() || (isCoinbase ? !keyName.trim() : !apiKey.trim())}
        >
          Add account
        </Button>
      </div>

      {accounts.length > 0 ? (
        <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {accounts.map((account) => (
            <li key={account.id} className="flex items-center gap-3 py-2.5">
              <input
                type="checkbox"
                checked={account.enabled === 1}
                aria-label={`Include ${account.label} in syncs`}
                onChange={(event) => setAccountEnabled(account.id, event.target.checked)}
                className="size-4 accent-black dark:accent-white"
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium truncate">{account.label}</span>
                  <Badge>{account.exchange}</Badge>
                </div>
                <div className="font-mono text-[11px] text-zinc-500 truncate">
                  {account.keyName ?? `${account.apiKey.slice(0, 8)}...`}
                </div>
              </div>

              <Button variant="danger" size="sm" onClick={() => removeAccount(account.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
};

export default ExchangesSection;
