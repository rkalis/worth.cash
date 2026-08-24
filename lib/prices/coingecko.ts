import { COINGECKO_PRO_API_BASE_URL, COINGECKO_PUBLIC_API_BASE_URL } from 'lib/constants';
import ky from 'lib/ky';
import { getRequestQueue } from 'lib/request-queue';
import { getApiKey, getRuntimeSettings } from 'lib/settings/runtime';
import type { CoinGeckoTier } from 'lib/settings/types';
import { MINUTE } from 'lib/utils/time';

export interface ResolvedCoinGeckoPlan {
  tier: Exclude<CoinGeckoTier, 'auto'>;
  baseUrl: string;
  headers: Record<string, string>;
  // How far back historical data goes. The free and demo plans are capped at 365 days; paid plans are not.
  historyLimitDays: number | null;
  requestsPerMinute: number;
}

// Free and demo keys are limited to a year of history, which is why the chart can be truncated even though
// we have the full event history to reconstruct it from.
const FREE_TIER_HISTORY_LIMIT_DAYS = 365;

// Deliberate underestimates. CoinGecko counts bursts strictly, and a 429 costs more in retry latency than
// the throughput we would gain by running closer to the real ceiling.
//
// Keyless access is far more restricted than a demo key, and treating the two the same was enough to get
// NFT floor lookups rate limited during a sync of a wallet with many collections.
const KEYLESS_REQUESTS_PER_MINUTE = 8;
const DEMO_REQUESTS_PER_MINUTE = 25;
const PRO_REQUESTS_PER_MINUTE = 400;

let resolvedPlan: ResolvedCoinGeckoPlan | undefined;
let planResolution: Promise<ResolvedCoinGeckoPlan> | undefined;

// Works out which CoinGecko plan the configured key belongs to.
//
// The plans differ in hostname *and* in the name of the auth header, so a demo key sent to the pro host
// fails and vice versa. Rather than making the user tell us which one they bought, we probe once and
// remember the answer for the session.
export const resolveCoinGeckoPlan = async (): Promise<ResolvedCoinGeckoPlan> => {
  if (resolvedPlan) return resolvedPlan;

  // Concurrent callers during startup share one probe instead of each firing their own.
  if (!planResolution) {
    planResolution = detectPlan().then((plan) => {
      resolvedPlan = plan;
      planResolution = undefined;
      return plan;
    });
  }

  return planResolution;
};

// Called when the user edits their key, so the next request re-probes rather than reusing a stale plan.
export const resetCoinGeckoPlan = (): void => {
  resolvedPlan = undefined;
  planResolution = undefined;
};

const detectPlan = async (): Promise<ResolvedCoinGeckoPlan> => {
  const apiKey = getApiKey('coingecko');
  const configuredTier = getRuntimeSettings().coingeckoTier;

  if (!apiKey) return publicPlan();

  if (configuredTier === 'pro') return proPlan(apiKey);
  if (configuredTier === 'public') return demoPlan(apiKey);

  // 'auto': try the paid host first, since that is the only one a pro key works against.
  if (await isPlanUsable(proPlan(apiKey))) return proPlan(apiKey);
  if (await isPlanUsable(demoPlan(apiKey))) return demoPlan(apiKey);

  // The key works against neither host. Falling back to keyless access is better than failing outright,
  // and the settings page surfaces the failed validation separately.
  return publicPlan();
};

const isPlanUsable = async (plan: ResolvedCoinGeckoPlan): Promise<boolean> => {
  try {
    const response = await ky.get(`${plan.baseUrl}/ping`, { headers: plan.headers, retry: 0, timeout: 15_000 });
    return response.ok;
  } catch {
    return false;
  }
};

const publicPlan = (): ResolvedCoinGeckoPlan => ({
  tier: 'public',
  baseUrl: COINGECKO_PUBLIC_API_BASE_URL,
  headers: {},
  historyLimitDays: FREE_TIER_HISTORY_LIMIT_DAYS,
  requestsPerMinute: KEYLESS_REQUESTS_PER_MINUTE,
});

const demoPlan = (apiKey: string): ResolvedCoinGeckoPlan => ({
  tier: 'public',
  baseUrl: COINGECKO_PUBLIC_API_BASE_URL,
  headers: { 'x-cg-demo-api-key': apiKey },
  historyLimitDays: FREE_TIER_HISTORY_LIMIT_DAYS,
  requestsPerMinute: DEMO_REQUESTS_PER_MINUTE,
});

const proPlan = (apiKey: string): ResolvedCoinGeckoPlan => ({
  tier: 'pro',
  baseUrl: COINGECKO_PRO_API_BASE_URL,
  headers: { 'x-cg-pro-api-key': apiKey },
  historyLimitDays: null,
  requestsPerMinute: PRO_REQUESTS_PER_MINUTE,
});

// A single queue for every CoinGecko call, since the rate limit is per key rather than per endpoint.
export interface CoinGeckoRequestOptions {
  timeout?: number;
  retryLimit?: number;
}

export const coinGeckoRequest = async <T>(
  path: string,
  searchParams?: Record<string, string>,
  options: CoinGeckoRequestOptions = {},
): Promise<T> => {
  const plan = await resolveCoinGeckoPlan();
  // Keyed by the rate itself, since keyless and demo both report tier 'public' but are limited differently
  // and must not end up sharing whichever queue happened to be created first.
  const queue = getRequestQueue(`coingecko:${plan.tier}:${plan.requestsPerMinute}`, {
    interval: MINUTE,
    intervalCap: plan.requestsPerMinute,
  });

  return queue.add(() =>
    ky
      .get(`${plan.baseUrl}${path}`, {
        headers: plan.headers,
        searchParams,
        retry: { limit: options.retryLimit ?? 3 },
        ...(options.timeout ? { timeout: options.timeout } : {}),
      })
      .json<T>(),
  );
};

export const parseCoinGeckoNumber = (value: string | number | undefined): number | null => {
  if (value === undefined || value === null || value === '') return null;

  const numericValue = Number(value);
  if (Number.isNaN(numericValue) || !Number.isFinite(numericValue)) return null;
  return numericValue;
};

// CoinGecko returns a bare filename like "missing_small_2x.png" instead of omitting the field when it has
// no artwork for an asset. Stored as-is that becomes a relative URL that resolves against our own origin and
// 404s, so anything that is not an absolute URL is treated as absent.
export const toAbsoluteCoinGeckoImageUrl = (value: string | undefined | null): string | undefined => {
  if (!value) return undefined;
  return value.startsWith('http://') || value.startsWith('https://') ? value : undefined;
};
