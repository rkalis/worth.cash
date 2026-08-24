import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTransactionCount = vi.fn();
const getBalance = vi.fn();
const getCode = vi.fn();

vi.mock('lib/chains', () => ({
  createViemPublicClientForChain: () => ({
    getTransactionCount: (...args: unknown[]) => getTransactionCount(...args),
    getBalance: (...args: unknown[]) => getBalance(...args),
    getCode: (...args: unknown[]) => getCode(...args),
  }),
}));

const { hasChainActivity } = await import('lib/sync/activity');

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const PULSECHAIN = 369;

describe('hasChainActivity', () => {
  beforeEach(() => {
    getTransactionCount.mockReset();
    getBalance.mockReset();
    getCode.mockReset();
  });

  it('treats a sent transaction as activity', async () => {
    getTransactionCount.mockResolvedValue(3);
    getBalance.mockResolvedValue(0n);

    expect(await hasChainActivity(1, ADDRESS)).toBe(true);
  });

  it('skips a chain the address has never touched', async () => {
    getTransactionCount.mockResolvedValue(0);
    getBalance.mockResolvedValue(0n);

    expect(await hasChainActivity(1, ADDRESS)).toBe(false);
  });

  // The reason this cannot be a plain nonce check, unlike revoke.cash's. Approvals require sending a
  // transaction; holding value does not. A wallet funded by an exchange withdrawal has a nonce of zero and a
  // real balance, and skipping it would report the holding as nonexistent.
  it('treats a native balance as activity even with no transactions sent', async () => {
    getTransactionCount.mockResolvedValue(0);
    getBalance.mockResolvedValue(1n);

    expect(await hasChainActivity(1, ADDRESS)).toBe(true);
  });

  // Skipping is an optimisation, so an unreachable chain must fall back to attempting the sync. Returning
  // false would silently record the chain as empty on nothing more than a network blip.
  it('assumes activity when the chain cannot be reached', async () => {
    getTransactionCount.mockRejectedValue(new Error('RPC down'));
    getBalance.mockRejectedValue(new Error('RPC down'));

    expect(await hasChainActivity(1, ADDRESS)).toBe(true);
  });

  describe('PulseChain', () => {
    // PulseChain forked Ethereum's state, so a pre-fork Ethereum user carries a non-zero nonce there without
    // ever having used PulseChain. A plain nonce check would call almost everyone active.
    it('ignores nonce inherited from the fork', async () => {
      getBalance.mockResolvedValue(0n);
      getTransactionCount.mockImplementation((args: { blockNumber?: bigint }) =>
        Promise.resolve(args?.blockNumber ? 12 : 12),
      );
      getCode.mockResolvedValue('0x');

      expect(await hasChainActivity(PULSECHAIN, ADDRESS)).toBe(false);
    });

    it('detects transactions sent after the fork', async () => {
      getBalance.mockResolvedValue(0n);
      getTransactionCount.mockImplementation((args: { blockNumber?: bigint }) =>
        Promise.resolve(args?.blockNumber ? 12 : 15),
      );
      getCode.mockResolvedValue('0x');

      expect(await hasChainActivity(PULSECHAIN, ADDRESS)).toBe(true);
    });

    // A contract's nonce does not move on ordinary use, so it cannot show post-fork activity either way.
    it('assumes a contract is active, since its nonce proves nothing', async () => {
      getBalance.mockResolvedValue(0n);
      getTransactionCount.mockResolvedValue(1);
      getCode.mockResolvedValue('0x6080604052');

      expect(await hasChainActivity(PULSECHAIN, ADDRESS)).toBe(true);
    });
  });
});
