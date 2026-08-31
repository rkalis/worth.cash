import type { SnapshotScope, StoredSnapshot, StoredWallet } from 'lib/db/schema';
import { diffWallets, scopeMatches, scopeMeasuredBy } from 'lib/history/scope';
import { describe, expect, it } from 'vitest';

const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const buildWallet = (address: string, addedAt: number): StoredWallet => ({ address, addedAt, enabled: 1 });

const buildSnapshot = (overrides: Partial<StoredSnapshot> = {}): StoredSnapshot => ({
  timestamp: 1_000,
  totalUsd: 100,
  createdAt: 1_000,
  balances: [],
  tokens: [],
  prices: [],
  nftCollections: [],
  nftHoldings: [],
  exchangeBalances: [],
  exchangeAccounts: [],
  exchangeAssetCoingeckoIds: {},
  manualHoldings: [],
  ...overrides,
});

const current: SnapshotScope = { wallets: [WALLET_A, WALLET_B], chainIds: null, includeTestnets: false };

describe('scopeMeasuredBy', () => {
  it('takes the stamp at its word when there is one', () => {
    const snapshot = buildSnapshot({
      scope: { wallets: [WALLET_A], chainIds: [1], includeTestnets: true },
    });

    expect(scopeMeasuredBy(snapshot, [], current)).toEqual({
      wallets: [WALLET_A],
      chainIds: [1],
      includeTestnets: true,
    });
  });

  // Without a stamp the only evidence is when each wallet was added: one added afterwards cannot have been
  // in the point.
  it('infers an unstamped point from when each wallet was added', () => {
    const snapshot = buildSnapshot({ createdAt: 5_000 });
    const wallets = [buildWallet(WALLET_A, 1_000), buildWallet(WALLET_B, 9_000)];

    expect(scopeMeasuredBy(snapshot, wallets, current).wallets).toEqual([WALLET_A]);
  });

  // A reconstructed point describes an old moment but measures whatever was tracked when it was built, so
  // the comparison has to be against when it was built.
  it('measures against when the point was built, not the moment it describes', () => {
    const reconstructed = buildSnapshot({ timestamp: 1_000, createdAt: 9_999 });
    const wallets = [buildWallet(WALLET_A, 1_000), buildWallet(WALLET_B, 5_000)];

    expect(scopeMeasuredBy(reconstructed, wallets, current).wallets).toEqual([WALLET_A, WALLET_B]);
  });

  // The headline safety property: someone who has never touched their wallet list must see no drift at
  // all, or a feature meant to fix wallet scope would rewrite their whole chart on first use.
  it('reports no drift for a user who never changed their wallets', () => {
    const wallets = [buildWallet(WALLET_A, 100), buildWallet(WALLET_B, 100)];
    const snapshots = [buildSnapshot({ createdAt: 5_000 }), buildSnapshot({ createdAt: 50_000 })];

    for (const snapshot of snapshots) {
      expect(scopeMatches(scopeMeasuredBy(snapshot, wallets, current), current)).toBe(true);
    }
  });

  it('takes an unstamped point to have the current chain scope', () => {
    const scoped: SnapshotScope = { wallets: [], chainIds: [1, 10], includeTestnets: true };
    const measured = scopeMeasuredBy(buildSnapshot(), [], scoped);

    expect(measured.chainIds).toEqual([1, 10]);
    expect(measured.includeTestnets).toBe(true);
  });
});

describe('scopeMatches', () => {
  it('ignores the order and the casing of addresses', () => {
    const a: SnapshotScope = { wallets: [WALLET_A, WALLET_B], chainIds: null, includeTestnets: false };
    const b: SnapshotScope = {
      wallets: [WALLET_B.toUpperCase(), WALLET_A.toUpperCase()],
      chainIds: null,
      includeTestnets: false,
    };

    expect(scopeMatches(a, b)).toBe(true);
  });

  // "Every chain" is a standing instruction; a list naming them all is a snapshot of today's registry and
  // stops including chains added later.
  it('distinguishes every chain from a list that happens to name them all', () => {
    const everyChain: SnapshotScope = { wallets: [], chainIds: null, includeTestnets: false };
    const listed: SnapshotScope = { wallets: [], chainIds: [1, 10], includeTestnets: false };

    expect(scopeMatches(everyChain, listed)).toBe(false);
  });

  it('notices a different wallet set', () => {
    expect(
      scopeMatches(
        { wallets: [WALLET_A], chainIds: null, includeTestnets: false },
        { wallets: [WALLET_A, WALLET_B], chainIds: null, includeTestnets: false },
      ),
    ).toBe(false);
  });
});

describe('diffWallets', () => {
  it('names what was added and what was removed', () => {
    expect(diffWallets([WALLET_A], [WALLET_B])).toEqual({ added: [WALLET_B], removed: [WALLET_A] });
  });

  it('finds nothing when both sides describe the same set', () => {
    expect(diffWallets([WALLET_A, WALLET_B], [WALLET_B.toUpperCase(), WALLET_A])).toEqual({
      added: [],
      removed: [],
    });
  });
});
