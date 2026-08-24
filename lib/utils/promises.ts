import PQueue from 'p-queue';
import { delay, timeout } from '.';

export const withFallback = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
  try {
    const result = await promise;
    if (result === undefined) return fallback;
    if (typeof result === 'string' && result.trim() === '') return fallback;
    return result;
  } catch {
    return fallback;
  }
};

export const mapAsync = async <T, U>(
  arrayPromise: readonly T[] | Promise<readonly T[]>,
  mapper: (entry: T) => Promise<U>,
) => {
  const array = await arrayPromise;
  return Promise.all(array.map(mapper));
};

export const mapAsyncBounded = async <T, U>(
  arrayPromise: readonly T[] | Promise<readonly T[]>,
  concurrency: number,
  mapper: (entry: T) => Promise<U>,
): Promise<U[]> => {
  const array = await arrayPromise;
  const queue = new PQueue({ concurrency });
  return queue.addAll(array.map((entry) => () => mapper(entry)));
};

export const withTimeout = async <T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> => {
  return await Promise.race([promise, timeout(ms, timeoutMessage)]);
};

export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: { retries: number; delayMs: number; shouldRetry?: (error: unknown) => boolean },
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (options.retries <= 0) throw error;
    if (options.shouldRetry && !options.shouldRetry(error)) throw error;

    await delay(options.delayMs);
    return withRetry(operation, { ...options, retries: options.retries - 1 });
  }
};
