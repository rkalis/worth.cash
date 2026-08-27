import { db } from 'lib/db';
import type { SnapshotScope, StoredSnapshot, StoredWallet } from 'lib/db/schema';
import { loadSettings } from 'lib/db/settings';

// What the portfolio is measured over right now.
export const currentWalletScope = async (): Promise<SnapshotScope> => {
  const [wallets, settings] = await Promise.all([db.wallets.toArray(), loadSettings()]);

  return {
    wallets: normaliseOwners(wallets.map((wallet) => wallet.address)),
    chainIds: settings.sync.enabledChainIds,
    includeTestnets: settings.sync.includeTestnets,
  };
};

// The scope a snapshot was measured over.
//
// A point recorded since scope was stamped says so outright. An older one has to be inferred, and the only
// evidence available is when each wallet was added: a wallet added after a point was built cannot have
// been in it. That is measured against `createdAt` rather than `timestamp`, because a reconstructed point
// is built long after the moment it describes and measures whatever was tracked when it was built.
//
// The chain half of an unstamped scope is taken to match the current one. There is no evidence either way,
// and guessing that it drifted would mark every existing point as wrong on the first run.
//
// The blind spot, which the UI states plainly: a wallet that was removed leaves no row, so a point that
// still counts it cannot be recognised here at all.
export const scopeMeasuredBy = (
  snapshot: StoredSnapshot,
  wallets: StoredWallet[],
  current: SnapshotScope,
): SnapshotScope => {
  if (snapshot.scope) return snapshot.scope;

  const measuredAt = snapshot.createdAt ?? snapshot.timestamp;

  return {
    wallets: normaliseOwners(wallets.filter((wallet) => wallet.addedAt <= measuredAt).map((wallet) => wallet.address)),
    chainIds: current.chainIds,
    includeTestnets: current.includeTestnets,
  };
};

export const scopeMatches = (a: SnapshotScope, b: SnapshotScope): boolean =>
  a.includeTestnets === b.includeTestnets &&
  sameChainIds(a.chainIds, b.chainIds) &&
  a.wallets.length === b.wallets.length &&
  normaliseOwners(a.wallets).every((wallet, index) => wallet === normaliseOwners(b.wallets)[index]);

export const diffWallets = (measured: string[], target: string[]): { added: string[]; removed: string[] } => {
  const measuredSet = new Set(normaliseOwners(measured));
  const targetSet = new Set(normaliseOwners(target));

  return {
    added: [...targetSet].filter((wallet) => !measuredSet.has(wallet)),
    removed: [...measuredSet].filter((wallet) => !targetSet.has(wallet)),
  };
};

// Lowercase and sorted, so two scopes describing the same wallets compare equal whatever order or casing
// they were written in.
export const normaliseOwners = (owners: string[]): string[] =>
  [...new Set(owners.map((owner) => owner.toLowerCase()))].sort();

// `null` means every supported chain, which is a different statement from a list that happens to name them
// all today: the list stops including chains the app adds later.
const sameChainIds = (a: number[] | null, b: number[] | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;

  const sortedA = [...a].sort((first, second) => first - second);
  const sortedB = [...b].sort((first, second) => first - second);

  return sortedA.every((chainId, index) => chainId === sortedB[index]);
};
