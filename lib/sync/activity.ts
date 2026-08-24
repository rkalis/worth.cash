import { ChainId } from '@revoke.cash/chains';
import { createViemPublicClientForChain } from 'lib/chains';
import { withTimeout } from 'lib/utils/promises';
import { SECOND } from 'lib/utils/time';
import type { Address } from 'viem';

// PulseChain forked Ethereum's state, so every address that ever used Ethereum before the fork carries a
// non-zero nonce there. A plain nonce check would therefore call almost every address active, making the
// optimisation useless on exactly the chain where it would help most.
const PULSECHAIN_FORK_BLOCK = 17_233_000n;

const ACTIVITY_CHECK_TIMEOUT = 15 * SECOND;

// Decides whether a chain is worth syncing for an address.
//
// Adapted from revoke.cash's `hasChainActivity`, with one deliberate difference. revoke.cash looks for token
// approvals, and granting one requires sending a transaction, so a nonce of zero proves there is nothing to
// find. A portfolio has no such guarantee: an address can hold real value having never sent a transaction at
// all, which is exactly what a fresh wallet funded by an exchange withdrawal looks like, or one that has only
// ever received an airdrop.
//
// So the nonce alone is not a safe negative here, and the native balance is checked alongside it. Both are
// single cheap calls, against a chain we would otherwise scan the entire log history of.
export const hasChainActivity = async (chainId: number, address: Address): Promise<boolean> => {
  try {
    const client = createViemPublicClientForChain(chainId);

    const [nonce, balance] = await withTimeout(
      Promise.all([client.getTransactionCount({ address }), client.getBalance({ address })]),
      ACTIVITY_CHECK_TIMEOUT,
      'Activity check timed out',
    );

    // Holding the native token counts as activity even with no transactions sent, because the balance is
    // real and belongs in the portfolio.
    if (balance > 0n) return true;

    if (chainId === ChainId.PulseChain) return hasPulseChainPostForkActivity(chainId, address, nonce);

    return nonce > 0;
  } catch {
    // An unreachable chain tells us nothing about the address. Assuming activity means we attempt the sync
    // and report a real error, rather than silently recording the chain as empty.
    return true;
  }
};

const hasPulseChainPostForkActivity = async (chainId: number, address: Address, nonce: number): Promise<boolean> => {
  try {
    const client = createViemPublicClientForChain(chainId);

    const [forkNonce, bytecode] = await Promise.all([
      client.getTransactionCount({ address, blockNumber: PULSECHAIN_FORK_BLOCK }),
      client.getCode({ address }),
    ]);

    // A contract's nonce does not increment on ordinary use, so it cannot tell us whether the contract has
    // been active since the fork. Assuming it has is the safe direction.
    if (bytecode && bytecode !== '0x') return true;

    return nonce > forkNonce;
  } catch {
    return true;
  }
};
