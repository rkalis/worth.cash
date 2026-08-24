import { buildValueAxis } from 'lib/history/axis';
import { describe, expect, it } from 'vitest';

describe('the value chart axis', () => {
  // The whole point of the change: the baseline is the origin, so the drawn height of a point is
  // proportional to what it is worth and two rises can be compared by eye.
  it('starts at zero however far above it the values sit', () => {
    const axis = buildValueAxis([276_900, 306_800, 384_300]);

    expect(axis.domain[0]).toBe(0);
    expect(axis.ticks[0]).toBe(0);
  });

  it('reaches at least the highest value', () => {
    const axis = buildValueAxis([276_900, 306_800, 384_300]);

    expect(axis.domain[1]).toBeGreaterThanOrEqual(384_300);
  });

  it('puts gridlines on round numbers', () => {
    expect(buildValueAxis([384_300]).ticks).toEqual([0, 100_000, 200_000, 300_000, 400_000]);
    expect(buildValueAxis([34_216]).ticks).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
    expect(buildValueAxis([99_000]).ticks).toEqual([0, 25_000, 50_000, 75_000, 100_000]);
  });

  it('never draws more than four gaps above the baseline', () => {
    const highestValues = [1, 7, 42, 410, 3_500, 34_216, 99_000, 384_300, 1_050_000, 2_400_000, 87_000_000];

    for (const highest of highestValues) {
      expect(buildValueAxis([highest]).ticks.length).toBeLessThanOrEqual(5);
    }
  });

  // Dead space above the line is the cost of rounding the top up to a readable number. A loose fit wastes
  // half the plot on emptiness, which is its own kind of misleading.
  it('does not leave a wasteful gap above the highest value', () => {
    const highestValues = [1, 7, 42, 410, 3_500, 34_216, 99_000, 384_300, 1_050_000, 2_400_000, 87_000_000];

    for (const highest of highestValues) {
      const [, top] = buildValueAxis([highest]).domain;
      expect(top / highest).toBeLessThanOrEqual(1.25);
    }
  });

  // The axis is drawn in dollars because that is what the snapshots hold, but it is read in whatever
  // currency the user picked, so the round numbers have to be round on the side they are read from.
  it('rounds the gridlines in the currency they are labelled in', () => {
    const rate = 0.8623;
    const axis = buildValueAxis([384_300], rate);

    expect(axis.ticks.map((tick) => Math.round(tick * rate))).toEqual([0, 100_000, 200_000, 300_000, 400_000]);
  });

  it('still reaches the highest value once converted', () => {
    const rate = 0.8623;
    const axis = buildValueAxis([384_300], rate);

    expect(axis.domain[1]).toBeGreaterThanOrEqual(384_300);
  });

  // A rate that never arrived must not collapse the axis to nothing; the app falls back to dollars in that
  // case, and so does this.
  it('falls back to dollars when the rate is unusable', () => {
    expect(buildValueAxis([384_300], 0).ticks).toEqual(buildValueAxis([384_300]).ticks);
    expect(buildValueAxis([384_300], Number.NaN).ticks).toEqual(buildValueAxis([384_300]).ticks);
  });

  it('draws an axis for a history that is empty, flat or worthless', () => {
    expect(buildValueAxis([])).toEqual({ domain: [0, 1], ticks: [0, 1] });
    expect(buildValueAxis([0, 0, 0])).toEqual({ domain: [0, 1], ticks: [0, 1] });

    const flat = buildValueAxis([5_000, 5_000]);
    expect(flat.domain[0]).toBe(0);
    expect(flat.domain[1]).toBeGreaterThanOrEqual(5_000);
  });

  it('ignores values that are not numbers', () => {
    const axis = buildValueAxis([Number.NaN, 34_216, Number.POSITIVE_INFINITY]);

    expect(axis.ticks).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
  });

  it('handles a portfolio worth less than a dollar', () => {
    const axis = buildValueAxis([0.4]);

    expect(axis.domain[0]).toBe(0);
    expect(axis.domain[1]).toBeGreaterThanOrEqual(0.4);
    expect(axis.ticks.length).toBeGreaterThan(1);
  });
});
