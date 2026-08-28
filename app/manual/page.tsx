'use client';

import ManualBalanceRow from 'components/manual/ManualBalanceRow';
import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import EmptyState from 'components/ui/EmptyState';
import InfoTooltip from 'components/ui/InfoTooltip';
import Input from 'components/ui/Input';
import Spinner from 'components/ui/Spinner';
import { getChainName, SUPPORTED_CHAINS } from 'lib/chains';
import { useCoinLogos } from 'lib/hooks/useCoinLogos';
import { useCurrency } from 'lib/hooks/useCurrency';
import { useExchangeAccounts } from 'lib/hooks/useExchangeAccounts';
import { useManualBalances } from 'lib/hooks/useManualBalances';
import { usePortfolio } from 'lib/hooks/usePortfolio';
import { useMemo, useState } from 'react';

const ManualBalancesPage = () => {
  const {
    holdings,
    entriesByBalance,
    addBalance,
    updateBalance,
    setBalanceEnabled,
    removeBalance,
    addEntry,
    updateEntry,
    removeEntry,
    isLoading,
  } = useManualBalances();

  const portfolio = usePortfolio();
  const { formatValue } = useCurrency();
  const { accounts } = useExchangeAccounts();
  const coinLogos = useCoinLogos();

  const [symbol, setSymbol] = useState('');
  const [location, setLocation] = useState('');
  const [wallet, setWallet] = useState('');
  const [coingeckoId, setCoingeckoId] = useState('');
  const [error, setError] = useState<string>();

  // The same vocabulary the rest of the portfolio uses for a location, offered as suggestions rather than
  // as a closed list: the holdings that need recording by hand are precisely the ones on chains the app does
  // not support, so Bitcoin and Solana have to be typeable even though they are not in the registry.
  const locationSuggestions = useMemo(() => {
    const chainNames = SUPPORTED_CHAINS.map((chainId) => getChainName(chainId));
    const exchangeNames = accounts.map((account) => account.label);

    return [...new Set(['Bitcoin', 'Solana', ...exchangeNames, ...chainNames])];
  }, [accounts]);

  // Priced from the same aggregation the dashboard renders, so the two cannot disagree about what a coin is
  // worth. Per holding rather than per location, because the portfolio deliberately collapses every wallet
  // in one place into a single line and this page is where they are listed individually.
  const priceByCoinId = useMemo(() => {
    const prices = new Map<string, number>();

    for (const token of portfolio.tokens) {
      if (token.coingeckoId && token.priceUsd !== null) prices.set(token.coingeckoId, token.priceUsd);
    }

    return prices;
  }, [portfolio.tokens]);

  // Most valuable first, the order the portfolio table is already read in.
  //
  // What comes out of the database is primary key order, which for generated ids is no order at all: the
  // holding worth the most sits wherever it happened to be added. A holding with no price has no value to
  // be sorted by and goes last rather than being ranked as though it were worth nothing, and those fall
  // back to their symbol so that a page of them is still in a readable order rather than an arbitrary one.
  const pricedHoldings = useMemo(() => {
    const withValue = holdings.map((holding) => {
      const priceUsd = holding.balance.coingeckoId ? priceByCoinId.get(holding.balance.coingeckoId) : undefined;

      return { holding, valueUsd: priceUsd === undefined ? null : holding.amount * priceUsd };
    });

    return withValue.sort(
      (a, b) =>
        (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || a.holding.balance.symbol.localeCompare(b.holding.balance.symbol),
    );
  }, [holdings, priceByCoinId]);

  const submit = async () => {
    setError(undefined);

    if (!symbol.trim() || !location.trim()) {
      setError('A symbol and a location are both required.');
      return;
    }

    try {
      await addBalance({ symbol, location, wallet, coingeckoId });
      setSymbol('');
      setLocation('');
      setWallet('');
      setCoingeckoId('');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  if (isLoading || portfolio.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-zinc-500">
        <Spinner className="size-5" />
      </div>
    );
  }

  const enabledCount = holdings.filter((holding) => holding.balance.enabled === 1).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1>Manual balances</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {enabledCount} holding{enabledCount === 1 ? '' : 's'} · {formatValue(portfolio.totals.manualUsd)}
        </p>
      </div>

      <Card bodyClassName="flex flex-col gap-4">
        <p className="text-xs text-zinc-600 dark:text-zinc-400 flex items-center gap-1.5">
          For holdings the app cannot see on its own: Bitcoin, Solana, a hardware wallet.
          <InfoTooltip tooltip="Record what you bought and sold and when, and the balance follows from the ledger, so your history accounts for it like a synced wallet. Give it a CoinGecko coin id and it joins the row for that asset in your portfolio, alongside wherever else you hold it." />
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-28">
            <Input
              name="manual-symbol"
              label="Symbol"
              placeholder="BTC"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
            />
          </div>

          <div className="flex-1 min-w-40">
            <Input
              name="manual-location"
              label="Chain or exchange"
              placeholder="Bitcoin"
              list="manual-location-suggestions"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
            <datalist id="manual-location-suggestions">
              {locationSuggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          </div>

          <div className="flex-1 min-w-36">
            <Input
              name="manual-wallet"
              label="Wallet (optional)"
              placeholder="Ledger"
              value={wallet}
              onChange={(event) => setWallet(event.target.value)}
            />
          </div>

          <div className="flex-1 min-w-36">
            <Input
              name="manual-coingecko-id"
              label="Price source"
              placeholder="bitcoin"
              value={coingeckoId}
              onChange={(event) => setCoingeckoId(event.target.value)}
            />
          </div>

          <Button variant="primary" onClick={submit}>
            Add balance
          </Button>
        </div>

        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </Card>

      {holdings.length === 0 ? (
        <EmptyState
          title="No manual balances yet"
          description="Add one above for anything the app cannot see: a Bitcoin wallet, a Solana address, coins on a hardware wallet."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {pricedHoldings.map(({ holding, valueUsd }) => (
            <ManualBalanceRow
              key={holding.balance.id}
              holding={holding}
              valueUsd={valueUsd}
              logoUrl={holding.balance.coingeckoId ? coinLogos[holding.balance.coingeckoId] : undefined}
              entries={entriesByBalance.get(holding.balance.id) ?? []}
              onUpdate={updateBalance}
              onToggle={setBalanceEnabled}
              onRemove={removeBalance}
              onAddEntry={addEntry}
              onUpdateEntry={updateEntry}
              onRemoveEntry={removeEntry}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ManualBalancesPage;
