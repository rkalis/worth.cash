import {
  buildNftPositions,
  buildTokenPositions,
  snapshotTimestampFromUtcInput,
  toUtcDateInputValue,
} from 'lib/history/snapshot';
import type { AggregatedNftCollection, AggregatedToken, TokenLocation } from 'lib/portfolio/aggregate';
import { describe, expect, it } from 'vitest';

const chainLocation = (chainId: number, amount: number, valueUsd: number | null): TokenLocation => ({
  kind: 'chain',
  key: `chain:${chainId}`,
  chainId,
  name: `Chain ${chainId}`,
  amount,
  valueUsd,
  contracts: [{ token: '0x0000000000000000000000000000000000000001', amount }],
});

const exchangeLocation = (accountId: string, amount: number, valueUsd: number | null): TokenLocation => ({
  kind: 'exchange',
  key: `exchange:${accountId}`,
  accountId,
  exchange: 'kraken',
  asset: 'ETH',
  name: 'Kraken',
  amount,
  valueUsd,
});

const buildToken = (locations: TokenLocation[], priceUsd: number): AggregatedToken => {
  const sumFor = (kind: 'chain' | 'exchange' | 'manual') =>
    locations.filter((location) => location.kind === kind).reduce((total, l) => total + (l.valueUsd ?? 0), 0);

  return {
    key: 'coin:ethereum',
    symbol: 'ETH',
    overrideKey: 'coin:ethereum',
    supersededOverrideKeys: [],
    totalAmount: locations.reduce((total, location) => total + location.amount, 0),
    priceUsd,
    valueUsd: sumFor('chain') + sumFor('exchange'),
    locations,
    chainValueUsd: sumFor('chain'),
    exchangeValueUsd: sumFor('exchange'),
    manualValueUsd: sumFor('manual'),
    isSpam: false,
    isHidden: false,
  };
};

describe('buildTokenPositions', () => {
  // A row can span chains and exchanges at once. Flattening it would lose the only record of how much was
  // on-chain versus sitting on an exchange at that moment.
  it('splits a merged row into one position per kind of place', () => {
    const positions = buildTokenPositions([
      buildToken([chainLocation(1, 4, 12000), exchangeLocation('kraken-1', 2, 6000)], 3000),
    ]);

    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({ kind: 'token', amount: 4, valueUsd: 12000 });
    expect(positions[1]).toMatchObject({ kind: 'exchange', amount: 2, valueUsd: 6000 });
  });

  it('emits a single position when an asset sits in only one kind of place', () => {
    const positions = buildTokenPositions([buildToken([chainLocation(1, 4, 12000)], 3000)]);

    expect(positions).toHaveLength(1);
    expect(positions[0].kind).toBe('token');
  });

  it('sums locations of the same kind into one position', () => {
    const positions = buildTokenPositions([
      buildToken([chainLocation(1, 4, 12000), chainLocation(8453, 1.5, 4500)], 3000),
    ]);

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ amount: 5.5, valueUsd: 16500 });
  });

  // The snapshot's total is the sum of its positions, so the split has to add back up to the row.
  it('preserves the row total across the split', () => {
    const token = buildToken([chainLocation(1, 4, 12000), exchangeLocation('kraken-1', 2, 6000)], 3000);
    const positions = buildTokenPositions([token]);

    expect(positions.reduce((total, position) => total + position.valueUsd, 0)).toBe(token.valueUsd);
  });
});

describe('buildNftPositions', () => {
  it('records a collection at its floor with the quantity held', () => {
    const collection = {
      key: '1:0xabc',
      chainId: 1,
      chainName: 'Ethereum',
      address: '0xabc',
      name: 'Cool Cats',
      itemCount: 3,
      floorPriceUsd: 900,
      valueUsd: 2700,
      items: [],
      isHidden: false,
    } as AggregatedNftCollection;

    expect(buildNftPositions([collection])[0]).toMatchObject({
      kind: 'nft',
      symbol: 'Cool Cats',
      amount: 3,
      priceUsd: 900,
      valueUsd: 2700,
    });
  });

  // An unpriced collection contributes nothing rather than NaN.
  it('values a collection with no floor at zero', () => {
    const collection = {
      key: '1:0xabc',
      chainId: 1,
      chainName: 'Ethereum',
      address: '0xabc',
      name: 'Unknown',
      itemCount: 1,
      floorPriceUsd: null,
      valueUsd: null,
      items: [],
      isHidden: false,
    } as AggregatedNftCollection;

    expect(buildNftPositions([collection])[0].valueUsd).toBe(0);
  });
});

describe('snapshotTimestampFromUtcInput', () => {
  // The fields are labelled UTC, so they have to be read as UTC. `new Date('2026-08-22T09:00')` would be
  // read as local time, which is silently wrong by hours and can land on the wrong day.
  it('reads the fields as UTC rather than local time', () => {
    expect(snapshotTimestampFromUtcInput('2026-08-22', '09:00')).toBe(Date.UTC(2026, 7, 22, 9, 0));
  });

  it('handles midnight and the end of the day', () => {
    expect(snapshotTimestampFromUtcInput('2026-01-01', '00:00')).toBe(Date.UTC(2026, 0, 1, 0, 0));
    expect(snapshotTimestampFromUtcInput('2026-12-31', '23:59')).toBe(Date.UTC(2026, 11, 31, 23, 59));
  });

  it('returns null for an incomplete or unparseable input', () => {
    expect(snapshotTimestampFromUtcInput('', '09:00')).toBeNull();
    expect(snapshotTimestampFromUtcInput('2026-08-22', '')).toBeNull();
    expect(snapshotTimestampFromUtcInput('not-a-date', '09:00')).toBeNull();
  });

  it('round-trips through the date input value', () => {
    const timestamp = Date.UTC(2026, 7, 22, 9, 0);
    expect(snapshotTimestampFromUtcInput(toUtcDateInputValue(timestamp), '09:00')).toBe(timestamp);
  });
});

describe('toUtcDateInputValue', () => {
  it('formats a moment as the date input expects, in UTC', () => {
    expect(toUtcDateInputValue(Date.UTC(2026, 7, 22, 23, 30))).toBe('2026-08-22');
  });
});
