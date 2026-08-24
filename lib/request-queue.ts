import type { RateLimit } from 'lib/types';
import PQueue from 'p-queue';

// A named, process-wide rate limiter. Queues are shared by identifier so that every chain served by the
// same Etherscan API key waits in the same line, which is what the upstream rate limit actually applies to.
export class RequestQueue {
  private queue: PQueue;

  constructor(
    public identifier: string,
    public rateLimit: RateLimit,
  ) {
    this.queue = new PQueue(rateLimit);
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(fn) as Promise<T>;
  }

  get pending(): number {
    return this.queue.pending + this.queue.size;
  }
}

const QUEUES = new Map<string, RequestQueue>();

export const getRequestQueue = (identifier: string, rateLimit: RateLimit): RequestQueue => {
  const existingQueue = QUEUES.get(identifier);
  if (existingQueue) return existingQueue;

  const queue = new RequestQueue(identifier, rateLimit);
  QUEUES.set(identifier, queue);
  return queue;
};
