import { ERC20_ABI } from 'lib/abis';
import { createViemPublicClientForChain, getChainConfig } from 'lib/chains';
import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import { db } from 'lib/db';
import { balanceKey } from 'lib/db/keys';
import type { StoredBalance } from 'lib/db/schema';
import { getCandidateTokens } from 'lib/sync/events';
import { chunkArray } from 'lib/utils';
import { type Address, getAddress } from 'viem';

export interface BalanceSyncResult {
  chainId: number;
  owner: Address;
  heldTokenCount: number;
}

// How many balanceOf calls go into a single multicall. Large enough to keep the request count down, small
// enough that one unresponsive token cannot push the whole batch past a node's gas or response limits.
const BALANCE_BATCH_SIZE = 100;

// Reads the actual on-chain balance for every token this address has ever touched on this chain.
//
// Balances are read rather than derived from the transfer events, even though we have the full event
// history. Rebasing tokens, fee-on-transfer tokens, and anything that mints or burns without emitting a
// Transfer would all produce a wrong number if we simply summed the events. The events tell us which tokens
// to ask about; the chain tells us how much of each is actually there.
export const syncTokenBalances = async (chainId: number, owner: Address): Promise<BalanceSyncResult> => {
  const candidates = await getCandidateTokens(chainId, owner);
  const fungibleTokens = candidates.filter((candidate) => candidate.standard === 'erc20').map(({ token }) => token);

  const client = createViemPublicClientForChain(chainId);
  const ownerAddress = getAddress(owner);

  const [nativeBalance, tokenBalances] = await Promise.all([
    client.getBalance({ address: ownerAddress }).catch(() => null),
    readTokenBalances(chainId, ownerAddress, fungibleTokens),
  ]);

  const heldBalances: StoredBalance[] = [];
  const emptyBalanceIds: string[] = [];
  const updatedAt = Date.now();

  if (nativeBalance !== null && nativeBalance > 0n) {
    heldBalances.push({
      id: balanceKey(chainId, owner, NATIVE_TOKEN_ADDRESS),
      chainId,
      owner: owner.toLowerCase(),
      token: NATIVE_TOKEN_ADDRESS,
      standard: 'erc20',
      amount: nativeBalance.toString(),
      updatedAt,
    });
  } else {
    emptyBalanceIds.push(balanceKey(chainId, owner, NATIVE_TOKEN_ADDRESS));
  }

  for (const [token, balance] of tokenBalances) {
    const id = balanceKey(chainId, owner, token);

    // Zero balances are deleted rather than stored. A wallet accumulates far more tokens it has fully sold
    // or been airdropped and dumped than tokens it actually holds, and keeping those rows would make every
    // portfolio read filter through them forever.
    if (balance === null || balance === 0n) {
      emptyBalanceIds.push(id);
      continue;
    }

    heldBalances.push({
      id,
      chainId,
      owner: owner.toLowerCase(),
      token: token.toLowerCase(),
      standard: 'erc20',
      amount: balance.toString(),
      updatedAt,
    });
  }

  await db.transaction('rw', db.balances, async () => {
    await db.balances.bulkDelete(emptyBalanceIds);
    await db.balances.bulkPut(heldBalances);
  });

  return { chainId, owner, heldTokenCount: heldBalances.length };
};

// Returns a balance per token, with `null` where the call failed. A failure here means the contract is
// broken or not actually an ERC20, which is common among airdropped spam, so it must not fail the batch.
const readTokenBalances = async (
  chainId: number,
  owner: Address,
  tokens: Address[],
): Promise<Array<[Address, bigint | null]>> => {
  if (tokens.length === 0) return [];

  const client = createViemPublicClientForChain(chainId);
  const multicallAddress = getChainConfig(chainId).getDeployedContracts()?.multicall3?.address;

  const results: Array<[Address, bigint | null]> = [];

  for (const batch of chunkArray(tokens, BALANCE_BATCH_SIZE)) {
    const contracts = batch.map((token) => ({
      address: getAddress(token),
      abi: ERC20_ABI,
      functionName: 'balanceOf' as const,
      args: [owner] as const,
    }));

    try {
      const batchResults = await client.multicall({
        contracts,
        allowFailure: true,
        ...(multicallAddress ? { multicallAddress } : {}),
      });

      batchResults.forEach((result, index) => {
        results.push([batch[index], result.status === 'success' ? (result.result as bigint) : null]);
      });
    } catch {
      // The whole multicall failed, which usually means the node rejected the batch rather than that any
      // individual token is broken. We record the batch as unknown and move on instead of aborting the chain.
      for (const token of batch) {
        results.push([token, null]);
      }
    }
  }

  return results;
};
