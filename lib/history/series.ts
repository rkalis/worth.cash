import { getChainConfig } from 'lib/chains';
import { NATIVE_TOKEN_ADDRESS } from 'lib/constants';
import { coingeckoPriceKey, onChainPriceKey } from 'lib/db/keys';
import type { StoredManualBalance, StoredManualLedgerEntry, StoredToken, StoredTransferEvent } from 'lib/db/schema';
import type { NativeBalanceSeries } from 'lib/history/native-balances';
import { amountAt, groupEntriesByBalance } from 'lib/manual/balances';
import { groupBy } from 'lib/utils';
import { formatUnits } from 'viem';

// Quantity histories, replayed from what is stored locally.
//
// Extracted from lib/history/reconstruct so that the wallet-scope reprocess can build the same series over
// many moments at once without duplicating the replay. Every builder here takes an array of timestamps and
// returns one amount per timestamp: they walk their events once in block order while advancing through the
// timestamps, so asking for a hundred moments costs one pass rather than a hundred.
//
// The timestamps must be ascending. Each builder advances a monotonic index through its events and never
// rewinds, so an unsorted list yields silently wrong amounts rather than an error.

export interface BalanceSeries {
  symbol: string;
  // One entry per requested moment, in the same order as `timestamps`.
  amounts: number[];
}

// Folds one chain's native balance history into the series for that coin.
//
// Summed rather than assigned, because every ETH rollup reports the same coin id: Base, Arbitrum and
// Ethereum all arrive as `ethereum`. Assigning would leave the chart showing whichever chain happened to be
// read last and silently understate the native holding.
export const mergeNativeBalanceSeries = (
  balanceSeries: Map<string, BalanceSeries>,
  nativeSeries: Pick<NativeBalanceSeries, 'coingeckoId' | 'symbol' | 'amounts'>,
): void => {
  const key = coingeckoPriceKey(nativeSeries.coingeckoId);
  const existing = balanceSeries.get(key);

  if (!existing) {
    balanceSeries.set(key, { symbol: nativeSeries.symbol, amounts: [...nativeSeries.amounts] });
    return;
  }

  existing.amounts = existing.amounts.map((amount, index) => amount + (nativeSeries.amounts[index] ?? 0));
};

// Walks each token's events once in block order while advancing through the timestamps, rather than re-scanning
// every event for every week. With hundreds of weeks and tens of thousands of events, the difference is
// between a fast rebuild and one that locks the tab.
export const buildTokenBalanceSeries = (
  events: StoredTransferEvent[],
  timestamps: number[],
  blocksByChain: Map<number, number[]>,
  tokensById: Map<string, StoredToken>,
): Map<string, BalanceSeries> => {
  const series = new Map<string, BalanceSeries>();
  const eventsByToken = groupBy(events, (event) => `${event.chainId}:${event.token}`);

  for (const [tokenId, tokenEvents] of eventsByToken) {
    const token = tokensById.get(tokenId);
    if (!token || token.decimals === undefined || token.isSpam === 1) continue;

    const chainBlocks = blocksByChain.get(tokenEvents[0].chainId);
    if (!chainBlocks) continue;

    const sorted = [...tokenEvents].sort((a, b) => a.blockNumber - b.blockNumber);

    const amounts: number[] = [];
    let runningBalance = 0n;
    let eventIndex = 0;

    for (let index = 0; index < timestamps.length; index += 1) {
      const blockAtTimestamp = chainBlocks[index];

      while (eventIndex < sorted.length && sorted[eventIndex].blockNumber <= blockAtTimestamp) {
        const event = sorted[eventIndex];
        const amount = BigInt(event.amount);

        // A transfer to and from the same owner nets to zero, which falls out of applying both branches.
        if (event.to === event.owner) runningBalance += amount;
        if (event.from === event.owner) runningBalance -= amount;

        eventIndex += 1;
      }

      // A negative running balance means we are missing an inbound transfer, so zero is the safer reading.
      const clamped = runningBalance > 0n ? runningBalance : 0n;
      amounts.push(Number(formatUnits(clamped, token.decimals)));
    }

    const priceKey =
      token.address === NATIVE_TOKEN_ADDRESS.toLowerCase()
        ? coingeckoPriceKey(
            token.coingeckoId ?? getChainConfig(token.chainId as never)?.getNativeTokenCoingeckoId() ?? token.address,
          )
        : onChainPriceKey(token.chainId, token.address);

    series.set(priceKey, { symbol: token.symbol ?? 'Unknown', amounts });
  }

  return series;
};

export interface NftSeries {
  name: string;
  counts: number[];
}

export const buildNftPositionSeries = (
  events: StoredTransferEvent[],
  timestamps: number[],
  blocksByChain: Map<number, number[]>,
  collectionNames: Map<string, string>,
): Map<string, NftSeries> => {
  const series = new Map<string, NftSeries>();
  const nftEvents = events.filter((event) => event.standard === 'erc721' || event.standard === 'erc1155');
  const eventsByCollection = groupBy(nftEvents, (event) => `${event.chainId}:${event.token}`);

  for (const [collectionKey, collectionEvents] of eventsByCollection) {
    const chainBlocks = blocksByChain.get(collectionEvents[0].chainId);
    if (!chainBlocks) continue;

    const sorted = [...collectionEvents].sort((a, b) => a.blockNumber - b.blockNumber);

    const counts: number[] = [];
    let runningCount = 0;
    let eventIndex = 0;

    for (let index = 0; index < timestamps.length; index += 1) {
      const blockAtTimestamp = chainBlocks[index];

      while (eventIndex < sorted.length && sorted[eventIndex].blockNumber <= blockAtTimestamp) {
        const event = sorted[eventIndex];
        const quantity = Number(event.amount || '1');

        if (event.to === event.owner) runningCount += quantity;
        if (event.from === event.owner) runningCount -= quantity;

        eventIndex += 1;
      }

      counts.push(Math.max(0, runningCount));
    }

    // Falls back to the key only when we have never resolved a name for the collection, so a stored
    // snapshot reads as "Pudgy Penguins" rather than "2741:0x0c99...".
    series.set(collectionKey, { name: collectionNames.get(collectionKey) ?? collectionKey, counts });
  }

  return series;
};

export const buildExchangeBalanceSeries = (
  ledgerEntries: Array<{ asset: string; amount: string; timestamp: number }>,
  timestamps: number[],
): Map<string, BalanceSeries> => {
  const series = new Map<string, BalanceSeries>();
  const entriesByAsset = groupBy(ledgerEntries, (entry) => entry.asset);

  for (const [asset, assetEntries] of entriesByAsset) {
    const sorted = [...assetEntries].sort((a, b) => a.timestamp - b.timestamp);

    const amounts: number[] = [];
    let runningBalance = 0;
    let entryIndex = 0;

    for (const snapshotTimestamp of timestamps) {
      while (entryIndex < sorted.length && sorted[entryIndex].timestamp <= snapshotTimestamp) {
        const amount = Number(sorted[entryIndex].amount);
        if (Number.isFinite(amount)) runningBalance += amount;
        entryIndex += 1;
      }

      amounts.push(Math.max(0, runningBalance));
    }

    // Keyed by asset for now; the CoinGecko id is substituted once resolved, in fetchPriceSeries.
    series.set(`exchange-asset:${asset}`, { symbol: asset, amounts });
  }

  return series;
};

export const keysHeldAt = (series: Map<string, BalanceSeries>, dustThresholdAmount: number): string[] =>
  [...series.entries()].filter(([, entry]) => entry.amounts[0] >= dustThresholdAmount).map(([priceKey]) => priceKey);

// The price keys we already know CoinGecko has no price for.
//

// One series per manual balance rather than per coin.
//
// Keyed by the balance id, not by `coingecko:${id}`, because a native token series already uses that key
// shape: a manual ETH holding would land on top of the on-chain ETH series inside the same Map and one of
// them would silently disappear. Two manual balances of the same coin in different places also stay
// separate this way, which is what their locations mean.
export const buildManualBalanceSeries = (
  balances: StoredManualBalance[],
  entries: StoredManualLedgerEntry[],
  timestamps: number[],
): Map<string, BalanceSeries> => {
  const entriesByBalance = groupEntriesByBalance(entries);
  const series = new Map<string, BalanceSeries>();

  for (const balance of balances) {
    const balanceEntries = entriesByBalance.get(balance.id) ?? [];
    if (balanceEntries.length === 0) continue;

    series.set(`manual:${balance.id}`, {
      symbol: balance.symbol.toUpperCase(),
      amounts: timestamps.map((timestamp) => amountAt(balanceEntries, timestamp)),
    });
  }

  return series;
};
