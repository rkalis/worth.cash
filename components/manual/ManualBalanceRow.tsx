'use client';

import Badge from 'components/ui/Badge';
import Button from 'components/ui/Button';
import Input from 'components/ui/Input';
import TokenLogo from 'components/ui/TokenLogo';
import { formatAmount, formatDateTimeUtc } from 'lib/format';
import { currentUtcTimeInput, snapshotTimestampFromUtcInput, toUtcDateInputValue } from 'lib/history/snapshot';
import { useCurrency } from 'lib/hooks/useCurrency';
import type { ManualBalanceInput, ManualLedgerInput } from 'lib/hooks/useManualBalances';
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
  onAddEntry: (input: ManualLedgerInput) => Promise<void>;
  onUpdateEntry: (id: string, changes: { kind: 'buy' | 'sell'; amount: string; timestamp: number }) => Promise<void>;
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
  onUpdateEntry,
  onRemoveEntry,
}: Props) => {
  const { formatValue } = useCurrency();
  const { balance, amount } = holding;

  const [isExpanded, setIsExpanded] = useState(entries.length === 0);
  const [kind, setKind] = useState<'buy' | 'sell'>('buy');
  const [entryAmount, setEntryAmount] = useState('');
  const [isAddingEntry, setIsAddingEntry] = useState(false);
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

    setIsAddingEntry(true);
    try {
      await onAddEntry({ balanceId: balance.id, kind, amount: entryAmount.trim(), timestamp });
      setEntryAmount('');
    } catch (submitError) {
      setEntryError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setIsAddingEntry(false);
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
                onBlur={(event) => {
                  const location = event.target.value.trim();
                  // Unchanged blurs write nothing, and the location cannot be blanked: the add form
                  // requires one, and a holding nowhere is not a holding.
                  if (location && location !== balance.location) onUpdate(balance.id, { location });
                }}
              />
            </div>

            <div className="w-36">
              <Input
                name={`manual-edit-wallet-${balance.id}`}
                label="Wallet"
                placeholder="Ledger"
                defaultValue={balance.wallet ?? ''}
                onBlur={(event) => {
                  if (event.target.value.trim() !== (balance.wallet ?? '')) {
                    onUpdate(balance.id, { wallet: event.target.value });
                  }
                }}
              />
            </div>

            <div className="w-36">
              <Input
                name={`manual-edit-price-source-${balance.id}`}
                label="Price source"
                placeholder="bitcoin"
                defaultValue={balance.coingeckoId ?? ''}
                onBlur={(event) => {
                  if (event.target.value.trim().toLowerCase() !== (balance.coingeckoId ?? '')) {
                    onUpdate(balance.id, { coingeckoId: event.target.value });
                  }
                }}
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

            <Button variant="secondary" onClick={submitEntry} loading={isAddingEntry} disabled={isAddingEntry}>
              Add entry
            </Button>
          </div>

          {entryError ? <p className="text-xs text-red-600 dark:text-red-400">{entryError}</p> : null}

          {entries.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No entries yet. Record the buy that gave you this holding, dated when it happened.
            </p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {entries.map((entry) => (
                  <LedgerEntryRow
                    key={entry.id}
                    entry={entry}
                    symbol={balance.symbol}
                    onUpdate={onUpdateEntry}
                    onRemove={onRemoveEntry}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
};

interface LedgerEntryRowProps {
  entry: { id: string; kind: 'buy' | 'sell'; amount: string; timestamp: number; note?: string };
  symbol: string;
  onUpdate: (id: string, changes: { kind: 'buy' | 'sell'; amount: string; timestamp: number }) => Promise<void>;
  onRemove: (id: string) => void;
}

// One ledger entry, readable by default and editable in place.
//
// Editing replaces the row with the same fields the add form uses, under the same rules: a positive
// amount, a real moment, and never one in the future. In place rather than in a dialog, because the thing
// being corrected is exactly what the row already shows.
const LedgerEntryRow = ({ entry, symbol, onUpdate, onRemove }: LedgerEntryRowProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [kind, setKind] = useState<'buy' | 'sell'>(entry.kind);
  const [amount, setAmount] = useState(entry.amount);
  const [date, setDate] = useState(() => toUtcDateInputValue(entry.timestamp));
  const [time, setTime] = useState(() => currentUtcTimeInput(entry.timestamp));
  const [editError, setEditError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);

  const startEditing = () => {
    // Re-seeded from the entry each time, so cancelling and reopening does not resurrect abandoned edits.
    setKind(entry.kind);
    setAmount(entry.amount);
    setDate(toUtcDateInputValue(entry.timestamp));
    setTime(currentUtcTimeInput(entry.timestamp));
    setEditError(undefined);
    setIsEditing(true);
  };

  const save = async () => {
    setEditError(undefined);

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setEditError('Enter an amount greater than zero.');
      return;
    }

    const timestamp = snapshotTimestampFromUtcInput(date, time);
    if (timestamp === null) {
      setEditError('Enter a valid date and time.');
      return;
    }

    // The same rule the add form applies: a future-dated entry is silently ignored by every replay, which
    // reads as the edit having been lost.
    if (timestamp > Date.now()) {
      setEditError('A ledger entry cannot be dated in the future.');
      return;
    }

    setIsSaving(true);
    try {
      await onUpdate(entry.id, { kind, amount: amount.trim(), timestamp });
      setIsEditing(false);
    } catch (saveError) {
      setEditError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setIsSaving(false);
    }
  };

  if (!isEditing) {
    return (
      <tr className="border-b border-zinc-100 dark:border-zinc-900 last:border-0">
        <td className="py-1.5 w-12">
          <span
            className={cn(
              entry.kind === 'buy' ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-500',
            )}
          >
            {entry.kind}
          </span>
        </td>
        <td className="py-1.5 tabular">{entry.amount}</td>
        <td className="py-1.5 text-zinc-500">{formatDateTimeUtc(entry.timestamp)}</td>
        <td className="py-1.5 text-right whitespace-nowrap">
          <button
            type="button"
            aria-label={`Edit the ${entry.kind} of ${entry.amount} ${symbol}`}
            className="text-zinc-400 hover:text-black dark:hover:text-white px-1"
            onClick={startEditing}
          >
            edit
          </button>
          <button
            type="button"
            aria-label={`Remove the ${entry.kind} of ${entry.amount} ${symbol}`}
            className="text-zinc-400 hover:text-red-600 dark:hover:text-red-400 px-1"
            onClick={() => onRemove(entry.id)}
          >
            remove
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-900 last:border-0">
      <td colSpan={4} className="py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {(['buy', 'sell'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={cn(
                  'px-2 h-8 rounded-md text-xs border transition-colors capitalize',
                  kind === option
                    ? 'border-zinc-900 dark:border-white bg-zinc-900 dark:bg-white text-white dark:text-black'
                    : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400',
                )}
              >
                {option}
              </button>
            ))}
          </div>

          <input
            aria-label="Amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="w-24 h-8 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-xs"
          />
          <input
            aria-label="Date (UTC)"
            type="date"
            value={date}
            max={toUtcDateInputValue(Date.now())}
            onChange={(event) => setDate(event.target.value)}
            className="h-8 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-xs"
          />
          <input
            aria-label="Time (UTC)"
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="h-8 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-xs"
          />

          <Button variant="primary" size="sm" onClick={save} loading={isSaving} disabled={isSaving}>
            Save
          </Button>
          <Button variant="tertiary" size="sm" onClick={() => setIsEditing(false)}>
            Cancel
          </Button>
        </div>

        {editError ? <p className="text-xs text-red-600 dark:text-red-400 mt-1">{editError}</p> : null}
      </td>
    </tr>
  );
};

export default ManualBalanceRow;
