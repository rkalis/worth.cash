import type { Filter, Log } from 'lib/events';
import { isLogRequestSizeError, isLogResponseSizeError, parseErrorMessage } from 'lib/utils/errors';
import { mapAsyncBounded } from 'lib/utils/promises';
import type { LogsProvider } from './LogsProvider';

export interface DivideAndConquerOptions {
  splitOnRequestSize?: boolean;
  // How many chunks of a pre-split range are requested at once. The per-provider rate limiter still applies,
  // so this only controls how deep the queue gets, not how fast we actually hit the API.
  chunkConcurrency?: number;
}

// What we have learned about each chain's provider limits, shared across every provider instance for that
// chain and kept for the lifetime of the page.
interface RangeLimits {
  // The widest block range the provider has actually served.
  maxSuccessfulSpan: number;
  // The narrowest block range it has refused. Anything at or above this is known to fail.
  minFailedSpan: number;
}

const RANGE_LIMITS = new Map<number, RangeLimits>();

const DEFAULT_CHUNK_CONCURRENCY = 4;

// Wraps a provider so that a block range which is too wide gets bisected until each half is servable.
//
// Pure bisection is correct but wasteful: against a provider that caps requests at 10k blocks, discovering
// that limit across a 20M block history costs roughly two thousand failed requests, because every level of
// the split has to fail before the next one is tried. So we also remember what each chain's provider has
// served and refused, and pre-split later requests to a size we already know works. The first filter on a
// chain pays the discovery cost; the remaining five, and every later wallet on that chain, do not.
export class DivideAndConquerLogsProvider implements LogsProvider {
  constructor(
    private underlyingProvider: LogsProvider,
    private options: DivideAndConquerOptions = {},
  ) {}

  get chainId(): number {
    return this.underlyingProvider.chainId;
  }

  async getLatestBlock(): Promise<number> {
    return this.underlyingProvider.getLatestBlock();
  }

  async getLogs(filter: Filter): Promise<Log[]> {
    const chunkSize = this.getPreferredChunkSize();
    const requestedSpan = spanOf(filter);

    // Only pre-split when it saves a meaningful amount of work; otherwise just try the request as asked.
    if (chunkSize && requestedSpan > chunkSize * 2) {
      return this.requestInChunks(filter, chunkSize);
    }

    return this.requestWithBisection(filter);
  }

  private async requestWithBisection(filter: Filter): Promise<Log[]> {
    try {
      const logs = await this.underlyingProvider.getLogs(filter);
      this.recordSuccess(spanOf(filter));
      return logs;
    } catch (error) {
      if (!this.isSplittableError(error)) throw error;

      this.recordFailure(spanOf(filter));

      // A single block that still returns too much data cannot be split any further.
      if (filter.fromBlock >= filter.toBlock) {
        if (isLogResponseSizeError(error)) {
          throw new Error(`Address has too much activity in a single block: ${parseErrorMessage(error)}`);
        }

        throw error;
      }

      return this.divideAndConquer(filter, 2);
    }
  }

  private async requestInChunks(filter: Filter, chunkSize: number): Promise<Log[]> {
    const chunks: Filter[] = [];
    for (let fromBlock = filter.fromBlock; fromBlock <= filter.toBlock; fromBlock += chunkSize) {
      chunks.push({ ...filter, fromBlock, toBlock: Math.min(fromBlock + chunkSize - 1, filter.toBlock) });
    }

    const results = await mapAsyncBounded(chunks, this.options.chunkConcurrency ?? DEFAULT_CHUNK_CONCURRENCY, (chunk) =>
      this.requestWithBisection(chunk),
    );

    return results.flat();
  }

  // The largest range worth attempting up front: comfortably below anything known to fail, and no smaller
  // than something we have already seen succeed.
  private getPreferredChunkSize(): number | undefined {
    const limits = RANGE_LIMITS.get(this.chainId);
    if (!limits) return undefined;

    if (limits.minFailedSpan === Number.POSITIVE_INFINITY) return undefined;

    return Math.max(1, Math.min(limits.maxSuccessfulSpan, Math.floor(limits.minFailedSpan / 2)));
  }

  private recordSuccess(span: number): void {
    const limits = this.getLimits();
    limits.maxSuccessfulSpan = Math.max(limits.maxSuccessfulSpan, span);
  }

  private recordFailure(span: number): void {
    const limits = this.getLimits();
    limits.minFailedSpan = Math.min(limits.minFailedSpan, span);
  }

  private getLimits(): RangeLimits {
    const existingLimits = RANGE_LIMITS.get(this.chainId);
    if (existingLimits) return existingLimits;

    const limits: RangeLimits = { maxSuccessfulSpan: 1, minFailedSpan: Number.POSITIVE_INFINITY };
    RANGE_LIMITS.set(this.chainId, limits);
    return limits;
  }

  private isSplittableError(error: unknown): boolean {
    if (isLogResponseSizeError(error)) return true;
    // Defaults to true: a provider that rejects the range outright is the most common reason to split, and
    // the only providers where this is unhelpful are ones that would fail the narrower request too.
    if (this.options.splitOnRequestSize !== false && isLogRequestSizeError(error)) return true;
    return false;
  }

  async divideAndConquer(filter: Filter, iterations: number): Promise<Log[]> {
    if (iterations === 1) return this.requestWithBisection(filter);

    const middle = filter.fromBlock + Math.floor((filter.toBlock - filter.fromBlock) / 2);
    const leftPromise = this.divideAndConquer({ ...filter, toBlock: middle }, iterations - 1);
    const rightPromise = this.divideAndConquer({ ...filter, fromBlock: middle + 1 }, iterations - 1);
    const [left, right] = await Promise.all([leftPromise, rightPromise]);
    return [...left, ...right];
  }
}

const spanOf = (filter: Filter): number => filter.toBlock - filter.fromBlock + 1;
