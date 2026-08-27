import type { SnapshotPosition, StoredNftItem } from 'lib/db/schema';
import type { AggregationInput, aggregateNftCollections, aggregateTokens } from 'lib/portfolio/aggregate';
import { formatUnits } from 'viem';

// Who contributed what to a position that was read from the chain.
//
// A recorded snapshot sums every wallet's holding of an asset into one figure, which is the right thing to
// show and the wrong thing to keep: once summed, a wallet cannot be taken back out. These functions split
// the sum at the moment it is recorded, from the same rows the aggregation was built from, so the split
// costs nothing and cannot disagree with the total it came from.

// Token amounts per owner, keyed by the aggregated row's key.
export const splitTokenPositionsByOwner = (
  tokens: ReturnType<typeof aggregateTokens>,
  input: AggregationInput,
): Map<string, Record<string, number>> => {
  const decimalsByToken = new Map(input.tokens.map((token) => [token.id, token.decimals]));

  // Every balance row is already one owner's holding of one token on one chain, which is exactly the
  // granularity the split needs. Grouping them by contract is all it takes to attribute a position.
  const balancesByToken = new Map<string, Array<{ owner: string; amount: string }>>();
  for (const balance of input.balances) {
    const key = `${balance.chainId}:${balance.token}`;
    const existing = balancesByToken.get(key);

    if (existing) {
      existing.push({ owner: balance.owner, amount: balance.amount });
    } else {
      balancesByToken.set(key, [{ owner: balance.owner, amount: balance.amount }]);
    }
  }

  const splits = new Map<string, Record<string, number>>();

  for (const token of tokens) {
    const amountByOwner: Record<string, number> = {};

    for (const location of token.locations) {
      // Only chain holdings have an owner. An exchange balance belongs to an account and a hand-entered
      // one to nobody, and neither is affected by which wallets are tracked.
      if (location.kind !== 'chain') continue;

      for (const contract of location.contracts) {
        const tokenId = `${location.chainId}:${contract.token}`;
        const decimals = decimalsByToken.get(tokenId);
        if (decimals === undefined) continue;

        for (const balance of balancesByToken.get(tokenId) ?? []) {
          const amount = Number(formatUnits(BigInt(balance.amount), decimals));
          if (amount === 0) continue;

          const owner = balance.owner.toLowerCase();
          amountByOwner[owner] = (amountByOwner[owner] ?? 0) + amount;
        }
      }
    }

    if (Object.keys(amountByOwner).length > 0) splits.set(token.key, amountByOwner);
  }

  return splits;
};

// Item counts per owner. Free, since an aggregated collection already carries the items it was built from.
export const splitNftPositionsByOwner = (
  collections: ReturnType<typeof aggregateNftCollections>,
): Map<string, Record<string, number>> => {
  const splits = new Map<string, Record<string, number>>();

  for (const collection of collections) {
    const countByOwner: Record<string, number> = {};

    for (const item of collection.items as StoredNftItem[]) {
      const owner = item.owner.toLowerCase();
      // ERC1155 holdings count quantities, matching how the collection's own itemCount is built.
      countByOwner[owner] = (countByOwner[owner] ?? 0) + Number(item.amount || '1');
    }

    if (Object.keys(countByOwner).length > 0) splits.set(collection.key, countByOwner);
  }

  return splits;
};

// Takes wallets back out of recorded positions, at the price each position already recorded.
//
// Pure arithmetic, no network calls and no replaying of anything: the recorded amount and the recorded
// price are both facts read at the time, and removing a wallet's share of the amount leaves the rest of
// the fact intact. This is the whole reason attribution is written in the first place.
export const subtractOwners = (
  positions: SnapshotPosition[],
  owners: string[],
  dustThresholdAmount: number,
): SnapshotPosition[] => {
  const removed = new Set(owners.map((owner) => owner.toLowerCase()));
  if (removed.size === 0) return positions;

  return positions.flatMap((position) => {
    // An exchange or hand-entered holding belongs to no wallet, so no wallet can be removed from it.
    if (position.kind !== 'token' && position.kind !== 'nft') return [position];
    if (!position.amountByOwner) return [position];

    const contribution = Object.entries(position.amountByOwner)
      .filter(([owner]) => removed.has(owner))
      .reduce((total, [, amount]) => total + amount, 0);

    if (contribution === 0) return [position];

    // Clamped, because the split is summed per owner while the recorded amount was summed as integers and
    // formatted once. The two agree to within a rounding error, and a negative amount is never right.
    const amount = Math.max(0, position.amount - contribution);
    const amountByOwner = Object.fromEntries(
      Object.entries(position.amountByOwner).filter(([owner]) => !removed.has(owner)),
    );

    // Below the minimum quantity it is a residue rather than a holding, by the same rule the portfolio
    // applies. This is also what disposes of the rounding error left by the clamp above.
    if (amount < dustThresholdAmount) return [];

    return [
      {
        ...position,
        amount,
        valueUsd: position.priceUsd === null ? 0 : amount * position.priceUsd,
        amountByOwner,
      },
    ];
  });
};
