import type { SnapshotPosition } from 'lib/db/schema';
import { subtractOwners } from 'lib/history/attribution';
import { describe, expect, it } from 'vitest';

const OWNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const DUST = 0.000001;

const buildPosition = (overrides: Partial<SnapshotPosition> = {}): SnapshotPosition => ({
  priceKey: 'coin:ethereum',
  symbol: 'ETH',
  amount: 10,
  priceUsd: 2000,
  valueUsd: 20_000,
  kind: 'token',
  amountByOwner: { [OWNER_A]: 6, [OWNER_B]: 4 },
  ...overrides,
});

describe('subtractOwners', () => {
  // The headline property: a wallet comes back out at the price the point already recorded, with no
  // network calls and nothing replayed.
  it('removes exactly one wallet share, at the recorded price', () => {
    const [position] = subtractOwners([buildPosition()], [OWNER_B], DUST);

    expect(position.amount).toBe(6);
    expect(position.priceUsd).toBe(2000);
    expect(position.valueUsd).toBe(12_000);
    expect(position.amountByOwner).toEqual({ [OWNER_A]: 6 });
  });

  it('drops a position whose whole amount belonged to the removed wallet', () => {
    const position = buildPosition({ amount: 4, amountByOwner: { [OWNER_B]: 4 } });

    expect(subtractOwners([position], [OWNER_B], DUST)).toEqual([]);
  });

  // Attribution sums per owner while the recorded amount was summed as integers and formatted once, so the
  // two agree only to within a rounding error. The dust rule is what disposes of the remainder.
  it('drops the residue a rounding error leaves behind', () => {
    const position = buildPosition({ amount: 4.0000000001, amountByOwner: { [OWNER_B]: 4 } });

    expect(subtractOwners([position], [OWNER_B], DUST)).toEqual([]);
  });

  it('never produces a negative amount', () => {
    const position = buildPosition({ amount: 3, amountByOwner: { [OWNER_B]: 4 } });

    expect(subtractOwners([position], [OWNER_B], 0)).toEqual([expect.objectContaining({ amount: 0, valueUsd: 0 })]);
  });

  it('leaves exchange and manual positions alone', () => {
    const positions: SnapshotPosition[] = [
      buildPosition({ kind: 'exchange', priceKey: 'coin:bitcoin', amountByOwner: { [OWNER_B]: 4 } }),
      buildPosition({ kind: 'manual', priceKey: 'manual:1', amountByOwner: { [OWNER_B]: 4 } }),
    ];

    expect(subtractOwners(positions, [OWNER_B], DUST)).toEqual(positions);
  });

  // A point recorded before attribution existed says nothing about who contributed what, and guessing
  // would be worse than leaving it.
  it('leaves an unattributed position untouched', () => {
    const position = buildPosition({ amountByOwner: undefined });

    expect(subtractOwners([position], [OWNER_B], DUST)).toEqual([position]);
  });

  it('does nothing when the removed wallet contributed nothing here', () => {
    const position = buildPosition({ amountByOwner: { [OWNER_A]: 10 } });

    expect(subtractOwners([position], [OWNER_B], DUST)).toEqual([position]);
  });

  it('keeps an unpriced position unpriced rather than valuing it at zero by accident', () => {
    const position = buildPosition({ priceUsd: null, valueUsd: 0 });
    const [subtracted] = subtractOwners([position], [OWNER_B], DUST);

    expect(subtracted.priceUsd).toBeNull();
    expect(subtracted.valueUsd).toBe(0);
    expect(subtracted.amount).toBe(6);
  });
});
