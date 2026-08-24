import kyBase, { HTTPError } from 'ky';
import PQueue from 'p-queue';

// A global concurrency cap so that a full multichain sync cannot open hundreds of sockets at once.
export const kyQueue = new PQueue({ concurrency: 50 });

const ky = kyBase.extend({
  timeout: 60_000,
  fetch: (input, options) => kyQueue.add(() => fetch(input, options)) as Promise<Response>,
  retry: {
    limit: 3,
    methods: ['get', 'put', 'head', 'delete', 'options', 'trace', 'post'],
  },
  hooks: {
    beforeRetry: [
      // POST requests are only retried when they were rate limited, since they are not generally idempotent.
      ({ request, error }) => {
        const isRateLimited = error instanceof HTTPError && error.response.status === 429;
        if (request.method === 'POST' && !isRateLimited) throw error;
      },
    ],
  },
});

export default ky;
