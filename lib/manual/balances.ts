import type { StoredManualBalance, StoredManualLedgerEntry } from 'lib/db/schema';

// A manual holding as the rest of the app sees it: what it is, where it is, and how much of it there is
// right now.
export interface ManualHolding {
  balance: StoredManualBalance;
  amount: number;
  entryCount: number;
}

// What one ledger entry does to a balance. A sell is stored as a positive amount with its direction in
// `kind`, because "sold 0.5" is what the user typed and a stored -0.5 is a thing they would have to decode
// every time they read the row back.
export const signedAmount = (entry: Pick<StoredManualLedgerEntry, 'kind' | 'amount'>): number => {
  const amount = Number(entry.amount);
  if (!Number.isFinite(amount)) return 0;

  return entry.kind === 'sell' ? -Math.abs(amount) : Math.abs(amount);
};

// The quantity held at a moment, from every entry recorded up to it.
//
// Clamped at zero. Selling more than the ledger says you had means an entry is missing, and a negative
// quantity would flow into the totals as a negative value, quietly subtracting from the rest of the
// portfolio. Zero is the safe reading of an incomplete ledger.
export const amountAt = (entries: StoredManualLedgerEntry[], timestamp: number = Date.now()): number => {
  const total = entries
    .filter((entry) => entry.timestamp <= timestamp)
    .reduce((running, entry) => running + signedAmount(entry), 0);

  return Math.max(0, total);
};

// Groups a flat ledger by the balance each entry belongs to, sorted oldest first so a running total can be
// walked in one pass.
export const groupEntriesByBalance = (entries: StoredManualLedgerEntry[]): Map<string, StoredManualLedgerEntry[]> => {
  const byBalance = new Map<string, StoredManualLedgerEntry[]>();

  for (const entry of entries) {
    const existing = byBalance.get(entry.balanceId);
    if (existing) {
      existing.push(entry);
    } else {
      byBalance.set(entry.balanceId, [entry]);
    }
  }

  for (const balanceEntries of byBalance.values()) {
    balanceEntries.sort((a, b) => a.timestamp - b.timestamp);
  }

  return byBalance;
};

// Every enabled manual balance with the quantity it currently holds.
//
// Balances that net to zero are kept rather than dropped: the holding still exists as something the user
// configured, and the settings list has to show it so they can add the entry that brings it back. Callers
// building a portfolio filter them out by amount.
export const buildManualHoldings = (
  balances: StoredManualBalance[],
  entries: StoredManualLedgerEntry[],
  timestamp: number = Date.now(),
): ManualHolding[] => {
  const entriesByBalance = groupEntriesByBalance(entries);

  return balances.map((balance) => {
    const balanceEntries = entriesByBalance.get(balance.id) ?? [];

    return {
      balance,
      amount: amountAt(balanceEntries, timestamp),
      entryCount: balanceEntries.length,
    };
  });
};

// The price key a manual balance is valued under, which is the same key an exchange or on-chain holding of
// the same coin uses. That shared key is what makes them one row in the portfolio rather than three.
export const manualIdentity = (balance: StoredManualBalance): string =>
  balance.coingeckoId ? `coin:${balance.coingeckoId}` : `manual:${balance.id}`;
