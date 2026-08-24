import { db } from 'lib/db';
import { historicalPriceKey } from 'lib/db/keys';
import type { StoredHistoricalPrice } from 'lib/db/schema';
import { coinGeckoRequest, resolveCoinGeckoPlan } from 'lib/prices/coingecko';
import { resolveAssetPlatformId } from 'lib/prices/platforms';
import { DAY, SECOND } from 'lib/utils/time';

interface MarketChartResponse {
  // Pairs of [millisecond timestamp, price].
  prices?: Array<[number, number]>;
}

export interface HistoricalPriceSeries {
  priceKey: string;
  // Sorted ascending by timestamp, so a lookup can walk it or binary search it.
  points: Array<{ timestamp: number; priceUsd: number }>;
}

export interface HistoryWindow {
  from: number;
  to: number;
  // True when the requested start was earlier than the plan allows and had to be moved forward.
  truncated: boolean;
}

// Works out how far back history can actually go, given the plan the configured key belongs to.
//
// The free and demo plans refuse any range starting more than 365 days ago, which is why a backfilled chart
// can be shorter than the wallet's real history. The UI reads `truncated` to explain that rather than
// silently drawing a chart that starts in the wrong place.
export const resolveHistoryWindow = async (requestedFrom: number, to: number = Date.now()): Promise<HistoryWindow> => {
  const plan = await resolveCoinGeckoPlan();

  if (plan.historyLimitDays === null) return { from: requestedFrom, to, truncated: false };

  const earliestAllowed = to - plan.historyLimitDays * DAY;

  if (requestedFrom >= earliestAllowed) return { from: requestedFrom, to, truncated: false };

  return { from: earliestAllowed, to, truncated: true };
};

// Fetches a whole date range of daily prices in one request, rather than one request per date.
//
// This is what makes the weekly backfill affordable: a wallet with 200 distinct tokens over three years
// costs 200 requests, not 200 times the number of weeks.
export const fetchHistoricalSeriesForCoin = async (
  coingeckoId: string,
  priceKey: string,
  window: HistoryWindow,
): Promise<HistoricalPriceSeries> => {
  return fetchAndStoreSeries(priceKey, `/coins/${encodeURIComponent(coingeckoId)}/market_chart/range`, window);
};

export const fetchHistoricalSeriesForContract = async (
  chainId: number,
  contractAddress: string,
  priceKey: string,
  window: HistoryWindow,
): Promise<HistoricalPriceSeries> => {
  const platformId = await resolveAssetPlatformId(chainId);

  // A chain CoinGecko has no asset platform for simply has no historical contract prices.
  if (!platformId) return { priceKey, points: [] };

  return fetchAndStoreSeries(
    priceKey,
    `/coins/${platformId}/contract/${contractAddress.toLowerCase()}/market_chart/range`,
    window,
  );
};

const fetchAndStoreSeries = async (
  priceKey: string,
  path: string,
  window: HistoryWindow,
): Promise<HistoricalPriceSeries> => {
  const cached = await loadCachedSeries(priceKey, window);
  if (cached.points.length > 0) return cached;

  try {
    const response = await coinGeckoRequest<MarketChartResponse>(path, {
      vs_currency: 'usd',
      // This endpoint takes seconds, unlike the millisecond timestamps it returns.
      from: String(Math.floor(window.from / SECOND)),
      to: String(Math.ceil(window.to / SECOND)),
    });

    const points = (response.prices ?? [])
      .map(([timestamp, priceUsd]) => ({ timestamp: startOfUtcDay(timestamp), priceUsd }))
      .filter((point) => Number.isFinite(point.priceUsd));

    // CoinGecko returns several points per day on shorter ranges; the last one for a day wins.
    const pointsByDay = new Map(points.map((point) => [point.timestamp, point.priceUsd]));

    const series: HistoricalPriceSeries = {
      priceKey,
      points: [...pointsByDay.entries()]
        .map(([timestamp, priceUsd]) => ({ timestamp, priceUsd }))
        .sort((a, b) => a.timestamp - b.timestamp),
    };

    await storeSeries(series);
    return series;
  } catch {
    // An asset CoinGecko has no history for is common, especially for small tokens. It contributes nothing
    // to the historical chart rather than failing the whole backfill.
    return { priceKey, points: [] };
  }
};

const loadCachedSeries = async (priceKey: string, window: HistoryWindow): Promise<HistoricalPriceSeries> => {
  const stored = await db.historicalPrices
    .where('[priceKey+timestamp]')
    .between([priceKey, window.from], [priceKey, window.to])
    .toArray();

  return {
    priceKey,
    points: stored
      .map((price) => ({ timestamp: price.timestamp, priceUsd: price.priceUsd }))
      .sort((a, b) => a.timestamp - b.timestamp),
  };
};

const storeSeries = async (series: HistoricalPriceSeries): Promise<void> => {
  if (series.points.length === 0) return;

  const rows: StoredHistoricalPrice[] = series.points.map((point) => ({
    id: historicalPriceKey(series.priceKey, point.timestamp),
    priceKey: series.priceKey,
    timestamp: point.timestamp,
    priceUsd: point.priceUsd,
  }));

  await db.historicalPrices.bulkPut(rows);
};

// Finds the price in effect at a given moment: the most recent point at or before it.
//
// Carrying the last known price forward is the right behaviour for a portfolio chart. A gap in CoinGecko's
// data does not mean the asset became worthless that week, which is what returning null would imply.
export const priceAt = (series: HistoricalPriceSeries, timestamp: number): number | null => {
  if (series.points.length === 0) return null;

  let low = 0;
  let high = series.points.length - 1;
  let result: number | null = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const point = series.points[middle];

    if (point.timestamp <= timestamp) {
      result = point.priceUsd;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
};

export const startOfUtcDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
