import { withLivePoint } from 'lib/history/periods';
import type { SnapshotPoint } from 'lib/hooks/useSnapshots';
import { describe, expect, it } from 'vitest';

const NOW = 1_000_000;

const points: SnapshotPoint[] = [
  { timestamp: NOW - 20_000, totalUsd: 100 },
  { timestamp: NOW - 10_000, totalUsd: 120 },
];

describe('withLivePoint', () => {
  // The point of it: the line ends where the headline beside it says it should.
  it('ends the line at what the portfolio is worth now', () => {
    const extended = withLivePoint(points, 150, NOW);

    expect(extended).toHaveLength(3);
    expect(extended.at(-1)).toEqual({ timestamp: NOW, totalUsd: 150 });
  });

  it('leaves the recorded points exactly as they were', () => {
    expect(withLivePoint(points, 150, NOW).slice(0, 2)).toEqual(points);
    expect(points).toHaveLength(2);
  });

  // A total of zero is a portfolio whose data was cleared or one mid-first-sync, not one that was sold.
  it('draws no cliff to zero when there is nothing to value', () => {
    expect(withLivePoint(points, 0, NOW)).toEqual(points);
  });

  it('has nothing to extend when nothing was ever recorded', () => {
    expect(withLivePoint([], 150, NOW)).toEqual([]);
  });

  // Out of order would draw the line backwards on a time axis.
  it('refuses to append a point that would not be last', () => {
    const future: SnapshotPoint[] = [{ timestamp: NOW + 5_000, totalUsd: 120 }];

    expect(withLivePoint(future, 150, NOW)).toEqual(future);
  });

  // One sync plus now is a line; one sync alone is a dot.
  it('gives a single recorded point something to be drawn against', () => {
    expect(withLivePoint([points[0]], 150, NOW)).toHaveLength(2);
  });
});
