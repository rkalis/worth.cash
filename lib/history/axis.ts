export interface ValueAxis {
  domain: [number, number];
  // Where the gridlines go, in USD, matching the domain. Passed to the axis explicitly because recharts
  // divides an explicit numeric domain into equal parts, which lands gridlines on whatever number falls
  // out of the arithmetic rather than on one worth reading.
  ticks: number[];
}

// How many gaps there are between the baseline and the top gridline, at most. Four reads comfortably at
// both chart heights in the app; more would crowd the 200px one on the dashboard.
const TICK_INTERVALS = 4;

// Gridline spacings a person reads without decoding: multiples of these, scaled by a power of ten. The list
// is denser than the usual 1/2/5 because each extra entry is a closer fit to the data, and a poor fit shows
// up as dead space between the highest point and the top of the chart.
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

// The vertical axis for a value chart, anchored at zero.
//
// Zero-based because the chart is read as a shape before it is read as numbers. An axis fitted to the
// values in view stretches whatever range it is given to fill the plot, so a quiet week where the portfolio
// moved half a percent draws the same peaks and troughs as a month where it halved, and only the labels
// tell them apart. Anchoring at zero costs the fine detail of a flat week and buys back the thing a chart
// is for: a rise that looks twice as big as another one is twice as big.
//
// `rate` is how many units of the display currency one dollar buys. Gridlines are chosen in the currency
// being read and then converted back to dollars to position them, so that a portfolio shown in euro gets
// round euro gridlines rather than round dollar ones converted into arbitrary euro numbers. This is the one
// place outside lib/format that touches the rate, and it is safe to: these are labels on an axis, not
// values anything is computed from.
export const buildValueAxis = (valuesUsd: number[], rate = 1): ValueAxis => {
  const usableRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const highest = Math.max(0, ...valuesUsd.filter((value) => Number.isFinite(value))) * usableRate;

  // An empty or worthless history still has to draw an axis, and a domain of [0, 0] gives recharts nothing
  // to scale against.
  if (highest <= 0) return { domain: [0, 1], ticks: [0, 1] };

  const step = niceStep(highest / TICK_INTERVALS);
  const intervals = Math.ceil(highest / step);

  const ticks = Array.from({ length: intervals + 1 }, (_, index) => (index * step) / usableRate);

  return { domain: [0, (intervals * step) / usableRate], ticks };
};

// The smallest readable spacing that is at least as wide as the one asked for. Rounding up rather than to
// the nearest keeps the gridline count at or below TICK_INTERVALS.
const niceStep = (rawStep: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;

  return (NICE_STEPS.find((candidate) => normalized <= candidate) ?? 10) * magnitude;
};
