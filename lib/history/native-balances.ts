import { createViemPublicClientForChain, getChainConfig } from 'lib/chains';
import { mapAsyncBounded } from 'lib/utils/promises';
import { type Address, formatUnits } from 'viem';

export interface NativeBalanceSeries {
  chainId: number;
  coingeckoId: string;
  symbol: string;
  // One entry per snapshot week, aligned with the `weeks` array it was built from.
  amounts: number[];
}

export interface NativeBalanceResult {
  series: NativeBalanceSeries[];
  // Chains whose RPC could not answer a historical balance query, so their native history is missing.
  chainsWithoutArchiveAccess: number[];
}

const BALANCE_CONCURRENCY = 4;

// Reads what the native balance was at each requested moment.
//
// This cannot be reconstructed the way token balances are. ETH, BNB, POL and friends move without emitting
// any event at all, so the transfer log history that every other part of the backfill relies on says nothing
// about them. Since the native token is usually the largest single holding, leaving it out would not be a
// small gap in the chart, it would make the chart wrong.
//
// The answer is to ask the chain directly for the balance at each historical block, which needs an archive
// node. Many public RPCs only retain recent state, so a chain whose node refuses is reported back rather
// than silently recorded as a zero balance, which would read as "sold everything".
export const readHistoricalNativeBalances = async (
  chainIds: number[],
  owners: Address[],
  weeks: number[],
  blocksByChain: Map<number, number[]>,
  onProgress?: (completed: number, total: number) => void,
): Promise<NativeBalanceResult> => {
  const series: NativeBalanceSeries[] = [];
  const chainsWithoutArchiveAccess: number[] = [];
  let completedChains = 0;

  for (const chainId of chainIds) {
    const chain = getChainConfig(chainId as never);
    const coingeckoId = chain?.getNativeTokenCoingeckoId();
    const blocks = blocksByChain.get(chainId);

    // Without a CoinGecko id the native token cannot be priced, so reading its history would cost a
    // request per week for a number we could never turn into a value.
    if (!chain || !coingeckoId || !blocks) continue;

    const client = createViemPublicClientForChain(chainId);
    const decimals = chain.getNativeTokenDecimals();

    // One cheap probe first, so a non-archive node costs a single failed request rather than one per week.
    const supportsHistoricalState = await client
      .getBalance({ address: owners[0], blockNumber: BigInt(blocks[0] || 1) })
      .then(() => true)
      .catch(() => false);

    if (!supportsHistoricalState) {
      chainsWithoutArchiveAccess.push(chainId);
      completedChains += 1;
      onProgress?.(completedChains, chainIds.length);
      continue;
    }

    // Iterating indices rather than the weeks themselves, since each week's balance is looked up by the
    // block recorded at the same position in `blocks`.
    const weekIndexes = weeks.map((_week, index) => index);

    const amounts = await mapAsyncBounded(weekIndexes, BALANCE_CONCURRENCY, async (index): Promise<number> => {
      const blockNumber = blocks[index];
      if (!blockNumber) return 0;

      const balances = await Promise.all(
        owners.map((owner) =>
          client
            .getBalance({ address: owner, blockNumber: BigInt(blockNumber) })
            .then((balance) => Number(formatUnits(balance, decimals)))
            .catch(() => 0),
        ),
      );

      // Every tracked wallet's balance on this chain, summed, since the portfolio is their total.
      return balances.reduce((total, balance) => total + balance, 0);
    });

    series.push({ chainId, coingeckoId, symbol: chain.getNativeToken(), amounts });
    completedChains += 1;
    onProgress?.(completedChains, chainIds.length);
  }

  return { series, chainsWithoutArchiveAccess };
};
