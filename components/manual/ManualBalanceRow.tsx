'use client';

import Badge from 'components/ui/Badge';
import Button from 'components/ui/Button';
import Input from 'components/ui/Input';
import TokenLogo from 'components/ui/TokenLogo';
import { formatAmount, formatDateTimeUtc } from 'lib/format';
import { currentUtcTimeInput, snapshotTimestampFromUtcInput, toUtcDateInputValue } from 'lib/history/snapshot';
import { useCurrency } from 'lib/hooks/useCurrency';
import type { ManualBalanceInput } from 'lib/hooks/useManualBalances';
import type { ManualHolding } from 'lib/manual/balances';
import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

interface Props {
  holding: ManualHolding;
  // What the holding is worth, taken from the same aggregation the portfolio renders, so this page and the
  // dashboard cannot disagree about it. Null when there is no price source, or no price yet.
  valueUsd: number | null;
  // Resolved from the price source's coin id. A manual holding has no contract to look up, so this is the
  // only icon it can have.
  logoUrl?: string;
  entries: Array<{ id: string; kind: 'buy' | 'sell'; amount: string; timestamp: number; note?: string }>;
  onUpdate: (id: string, changes: Partial<ManualBalanceInput>) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onAddEntry: (input: {
    balanceId: string;
    kind: 'buy' | 'sell';
    amount: string;
    timestamp: number;
    note?: string;
  }) => Promise<void>;
  onRemoveEntry: (id: string) => void;
}

const ManualBalanceRow = ({
  holding,
  valueUsd,
  logoUrl,
  entries,
  onUpdate,
  onToggle,
  onRemove,
  onAddEntry,
  onRemoveEntry,
}: Props) => {
  const { formatValue } = useCurrency();
  const { balance, amount } = holding;

  const [isExpanded, setIsExpanded] = useState(entries.length === 0);
  const [kind, setKind] = useState<'buy' | 'sell'>('buy');
  const [entryAmount, setEntryAmount] = useState('');
  const [date, setDate] = useState(() => toUtcDateInputValue(Date.now()));
  const [time, setTime] = useState(() => currentUtcTimeInput());
  const [entryError, setEntryError] = useState<string>();

  const submitEntry = async () => {
    setEntryError(undefined);

    const parsedAmount = Number(entryAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setEntryError('Enter an amount greater than zero.');
      return;
    }

    const timestamp = snapshotTimestampFromUtcInput(date, time);
    if (timestamp === null) {
      setEntryError('Enter a valid date and time.');
      return;
    }

    // A future-dated entry counts towards nothing: the balance is summed from entries up to now, so it
    // would sit in the list looking recorded while the holding read as zero.
    if (timestamp > Date.now()) {
      setEntryError('A ledger entry cannot be dated in the future.');
      return;
    }

    try {
      await onAddEntry({ balanceId: balance.id, kind, amount: entryAmount.trim(), timestamp });
      setEntryAmount('');
    } catch (submitError) {
      setEntryError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <TokenLogo src={logoUrl} symbol={balance.symbol} size={20} />

        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-sm">{balance.symbol}</span>
            {balance.enabled === 0 ? <Badge>disabled</Badge> : null}
            {!balance.coingeckoId ? <Badge variant="warning">no price source</Badge> : null}
          </div>
          <div className="text-[11px] text-zinc-500 truncate">
            {balance.wallet ? `${balance.location} · ${balance.wallet}` : balance.location}
          </div>
        </div>

        <div className="ml-auto text-right">
          <div className="text-sm tabular font-medium">{formatValue(valueUsd)}</div>
          <div className="text-[11px] text-zinc-500 tabular">
            {formatAmount(amount)} {balance.symbol}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="tertiary" size="sm" onClick={() => setIsExpanded(!isExpanded)}>
            {isExpanded ? 'Hide' : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
          </Button>
          <button
            type="button"
            className="text-xs text-zinc-400 hover:text-black dark:hover:text-white px-1"
            onClick={() => onToggle(balance.id, balance.enabled === 0)}
          >
            {balance.enabled === 1 ? 'disable' : 'enable'}
          </button>
          <button
            type="button"
            className="text-xs text-zinc-400 hover:text-red-600 dark:hover:text-red-400 px-1"
            onClick={() => onRemove(balance.id)}
          >
            remove
          </button>
        </div>
      </div>

      {isExpanded ? (
        <div className="border-t border-zinc-200 dark:border-zinc-800 px-3 py-3 flex flex-col gap-3">
          {/* Editable in place. A mistyped coin id otherwise leaves the holding unpriced with no way back
              except deleting the balance, which would take its whole ledger with it. */}
          <div className="flex flex-wrap items-end gap-2 pb-3 border-b border-zinc-100 dark:border-zinc-900">
            <div className="w-40">
              <Input
                name={`manual-edit-location-${balance.id}`}
                label="Chain or exchange"
                defaultValue={balance.location}
                onBlur={(event) => onUpdate(balance.id, { location: event.target.value })}
              />
            </div>

            <div className="w-36">
              <Input
                name={`manual-edit-wallet-${balance.id}`}
                label="Wallet"
                placeholder="Ledger"
                defaultValue={balance.wallet ?? ''}
                onBlur={(event) => onUpdate(balance.id, { wallet: event.target.value })}
              />
            </div>

            <div className="w-36">
              <Input
                name={`manual-edit-price-source-${balance.id}`}
                label="Price source"
                placeholder="bitcoin"
                defaultValue={balance.coingeckoId ?? ''}
                onBlur={(event) => onUpdate(balance.id, { coingeckoId: event.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex gap-1">
              {(['buy', 'sell'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setKind(option)}
                  className={cn(
                    'px-3 h-9 rounded-lg text-sm border transition-colors capitalize',
                    kind === option
                      ? 'border-zinc-900 dark:border-white bg-zinc-900 dark:bg-white text-white dark:text-black'
                      : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>

            <div className="w-32">
              <Input
                name={`manual-amount-${balance.id}`}
                label="Amount"
                placeholder="0.5"
                value={entryAmount}
                onChange={(event) => setEntryAmount(event.target.value)}
              />
            </div>

            <div className="w-40">
              <Input
                name={`manual-date-${balance.id}`}
                label="Date (UTC)"
                type="date"
                value={date}
                max={toUtcDateInputValue(Date.now())}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>

            <div className="w-28">
              <Input
                name={`manual-time-${balance.id}`}
                label="Time (UTC)"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>

            <Button variant="secondary" size="sm" onClick={submitEntry}>
              Add entry
            </Button>
          </div>

          {entryError ? <p className="text-xs text-red-600 dark:text-red-400">{entryError}</p> : null}

          {entries.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No entries yet. Record the buy that gave you this holding, dated when it happened, and the history will
              value it from that moment on.
            </p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b border-zinc-100 dark:border-zinc-900 last:border-0">
                    <td className="py-1.5 w-12">
                      <span
                        className={cn(
                          entry.kind === 'buy'
                            ? 'text-green-600 dark:text-green-500'
                            : 'text-red-600 dark:text-red-500',
                        )}
                      >
                        {entry.kind}
                      </span>
                    </td>
                    <td className="py-1.5 tabular">{entry.amount}</td>
                    <td className="py-1.5 text-zinc-500">{formatDateTimeUtc(entry.timestamp)}</td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        aria-label={`Remove the ${entry.kind} of ${entry.amount} ${balance.symbol}`}
                        className="text-zinc-400 hover:text-red-600 dark:hover:text-red-400 px-1"
                        onClick={() => onRemoveEntry(entry.id)}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
};

export default ManualBalanceRow;
