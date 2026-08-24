import type { StoredManualBalance, StoredManualLedgerEntry } from 'lib/db/schema';
import { currentUtcTimeInput, snapshotTimestampFromUtcInput } from 'lib/history/snapshot';
import { amountAt, buildManualHoldings, groupEntriesByBalance, signedAmount } from 'lib/manual/balances';
import { describe, expect, it } from 'vitest';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 24, 9, 0);

const entry = (
  kind: 'buy' | 'sell',
  amount: string,
  daysAgo: number,
  balanceId = 'balance-1',
): StoredManualLedgerEntry => ({
  id: `${kind}-${amount}-${daysAgo}`,
  balanceId,
  kind,
  amount,
  timestamp: NOW - daysAgo * DAY,
});

const balance = (id: string, overrides: Partial<StoredManualBalance> = {}): StoredManualBalance => ({
  id,
  symbol: 'BTC',
  location: 'Ledger Nano',
  coingeckoId: 'bitcoin',
  createdAt: 0,
  enabled: 1,
  ...overrides,
});

describe('signedAmount', () => {
  it('treats a buy as an increase and a sell as a decrease', () => {
    expect(signedAmount({ kind: 'buy', amount: '0.5' })).toBe(0.5);
    expect(signedAmount({ kind: 'sell', amount: '0.5' })).toBe(-0.5);
  });

  // The direction lives in `kind`, so a stray minus sign in the amount must not flip it back.
  it('ignores a sign in the stored amount', () => {
    expect(signedAmount({ kind: 'buy', amount: '-0.5' })).toBe(0.5);
    expect(signedAmount({ kind: 'sell', amount: '-0.5' })).toBe(-0.5);
  });

  it('reads an unparseable amount as nothing rather than NaN', () => {
    expect(signedAmount({ kind: 'buy', amount: 'abc' })).toBe(0);
    expect(signedAmount({ kind: 'buy', amount: '' })).toBe(0);
  });
});

describe('amountAt', () => {
  it('sums the ledger up to the moment asked for', () => {
    const entries = [entry('buy', '1', 30), entry('buy', '0.5', 20), entry('sell', '0.25', 10)];

    expect(amountAt(entries, NOW)).toBe(1.25);
  });

  // The whole point of the ledger: a past moment sees only what had happened by then.
  it('ignores entries dated after the moment', () => {
    const entries = [entry('buy', '1', 30), entry('buy', '5', 5)];

    expect(amountAt(entries, NOW - 10 * DAY)).toBe(1);
  });

  it('includes an entry landing exactly on the moment', () => {
    expect(amountAt([entry('buy', '2', 10)], NOW - 10 * DAY)).toBe(2);
  });

  it('is zero before the first entry', () => {
    expect(amountAt([entry('buy', '1', 10)], NOW - 30 * DAY)).toBe(0);
  });

  // Selling more than the ledger records means an entry is missing. A negative quantity would flow into the
  // totals as negative value and quietly subtract from the rest of the portfolio.
  it('never goes negative when the ledger is incomplete', () => {
    const entries = [entry('buy', '1', 30), entry('sell', '3', 10)];

    expect(amountAt(entries, NOW)).toBe(0);
  });

  it('handles an empty ledger', () => {
    expect(amountAt([], NOW)).toBe(0);
  });
});

describe('groupEntriesByBalance', () => {
  it('splits a flat ledger by balance and sorts each oldest first', () => {
    const grouped = groupEntriesByBalance([
      entry('buy', '1', 10, 'balance-2'),
      entry('buy', '2', 30, 'balance-1'),
      entry('buy', '3', 20, 'balance-1'),
    ]);

    expect([...grouped.keys()].sort()).toEqual(['balance-1', 'balance-2']);
    expect(grouped.get('balance-1')?.map((e) => e.amount)).toEqual(['2', '3']);
  });
});

describe('buildManualHoldings', () => {
  it('derives the quantity from the ledger', () => {
    const holdings = buildManualHoldings(
      [balance('balance-1')],
      [entry('buy', '1', 30), entry('sell', '0.4', 10)],
      NOW,
    );

    expect(holdings[0]).toMatchObject({ amount: 0.6, entryCount: 2 });
  });

  // The holding still exists as something the user configured, so the settings list can show it and they can
  // add the entry that brings it back.
  it('keeps a balance whose ledger nets to zero', () => {
    const holdings = buildManualHoldings([balance('balance-1')], [entry('buy', '1', 30), entry('sell', '1', 10)], NOW);

    expect(holdings).toHaveLength(1);
    expect(holdings[0].amount).toBe(0);
  });

  it('keeps a balance with no entries at all', () => {
    const holdings = buildManualHoldings([balance('balance-1')], [], NOW);

    expect(holdings[0]).toMatchObject({ amount: 0, entryCount: 0 });
  });

  it('keeps two balances of the same coin in different places apart', () => {
    const holdings = buildManualHoldings(
      [balance('balance-1', { location: 'Ledger' }), balance('balance-2', { location: 'Cold storage' })],
      [entry('buy', '1', 10, 'balance-1'), entry('buy', '2', 10, 'balance-2')],
      NOW,
    );

    expect(holdings.map((holding) => holding.amount)).toEqual([1, 2]);
  });
});

describe('currentUtcTimeInput', () => {
  // A ledger entry records when a trade happened. Defaulting it to 09:00, as the snapshot form does, dates
  // it in the future for anyone filling the form earlier in the UTC day, and a future-dated entry counts
  // towards nothing: the balance would read zero with the entry sitting right there in the list.
  it('never produces a future timestamp when paired with today', () => {
    const now = Date.UTC(2026, 7, 24, 2, 0);
    const date = new Date(now).toISOString().slice(0, 10);

    const timestamp = snapshotTimestampFromUtcInput(date, currentUtcTimeInput(now));

    expect(timestamp).not.toBeNull();
    expect(timestamp as number).toBeLessThanOrEqual(now);
  });

  it('formats as the time input expects', () => {
    expect(currentUtcTimeInput(Date.UTC(2026, 7, 24, 2, 5))).toBe('02:05');
    expect(currentUtcTimeInput(Date.UTC(2026, 7, 24, 23, 59))).toBe('23:59');
  });

  // The bug this replaced: 09:00 is seven hours ahead of 02:00.
  it('is not the snapshot hour early in the UTC day', () => {
    expect(currentUtcTimeInput(Date.UTC(2026, 7, 24, 2, 0))).not.toBe('09:00');
  });
});

describe('manual location and wallet', () => {
  // The location names the chain or exchange so a breakdown groups two wallets on the same chain together;
  // the wallet is the detail underneath it.
  it('carries the wallet alongside the location', () => {
    const holdings = buildManualHoldings(
      [balance('balance-1', { location: 'Bitcoin', wallet: 'Ledger' })],
      [entry('buy', '1', 10)],
      NOW,
    );

    expect(holdings[0].balance.location).toBe('Bitcoin');
    expect(holdings[0].balance.wallet).toBe('Ledger');
  });

  it('leaves the wallet unset when there is nothing useful to say', () => {
    const holdings = buildManualHoldings([balance('balance-1', { wallet: undefined })], [entry('buy', '1', 10)], NOW);

    expect(holdings[0].balance.wallet).toBeUndefined();
  });
});
