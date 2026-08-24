import type { Event } from '@envio-dev/hypersync-client';
import { SUPPORTED_CHAINS } from 'lib/chains';
import type { Log } from 'lib/events';
import { isNullish } from 'lib/utils';
import { getAddress, type Hash, type Hex } from 'viem';
import { z } from 'zod';

// HyperSync's client is a native Node addon, so this route exists purely to run it somewhere the browser
// cannot. It holds no credentials of its own: the caller's token arrives on each request and is used only
// for that request.
export const runtime = 'nodejs';

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'Expected a hex string');

// The chain id is interpolated into the HyperSync hostname, so it is restricted to chains we actually
// support rather than merely validated as a number. Without this, a caller could steer the server at an
// arbitrary `*.hypersync.xyz` subdomain.
const chainIdSchema = z
  .number()
  .int()
  .refine((chainId) => SUPPORTED_CHAINS.includes(chainId as never), {
    message: 'Unsupported chain id',
  });

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('height'), chainId: chainIdSchema }),
  z.object({
    action: z.literal('logs'),
    chainId: chainIdSchema,
    filter: z.object({
      fromBlock: z.number().int().nonnegative(),
      toBlock: z.number().int().nonnegative(),
      address: hexSchema.optional(),
      topics: z.array(z.array(hexSchema)).max(4),
    }),
  }),
]);

export async function POST(request: Request) {
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsedBody.success) {
    return Response.json({ message: 'Invalid request', issues: parsedBody.error.issues }, { status: 400 });
  }

  const apiToken = request.headers.get('x-hypersync-key') ?? undefined;
  const { action, chainId } = parsedBody.data;

  try {
    const client = await createClient(chainId, apiToken);

    if (action === 'height') {
      return Response.json({ height: await client.getHeight() });
    }

    const { filter } = parsedBody.data;
    const eventResponse = await client.collectEvents(
      {
        fromBlock: filter.fromBlock,
        toBlock: filter.toBlock,
        logs: [{ address: filter.address ? [filter.address] : undefined, topics: filter.topics }],
        fieldSelection: {
          log: [
            'Address',
            'Data',
            'Topic0',
            'Topic1',
            'Topic2',
            'Topic3',
            'BlockNumber',
            'TransactionHash',
            'LogIndex',
            'TransactionIndex',
          ],
          block: ['Timestamp'],
        },
      },
      {},
    );

    return Response.json({ logs: eventResponse.data.map(formatEvent) });
  } catch (error) {
    // The message is forwarded verbatim because the client inspects it to decide whether the block range
    // needs to be narrowed and retried.
    const message = error instanceof Error ? error.message : 'HyperSync request failed';
    return Response.json({ message }, { status: 502 });
  }
}

const createClient = async (chainId: number, apiToken?: string) => {
  const { HypersyncClient } = await import('@envio-dev/hypersync-client');

  // The default of 12 retries with backoff outlasts our own timeouts, which would relabel connection errors
  // as generic timeouts and cause the caller to split block ranges for no reason.
  // The client's type marks apiToken as required, but HyperSync itself serves keyless requests at a lower
  // rate limit, so an empty token is a valid anonymous request rather than a broken one.
  return new HypersyncClient({ url: `https://${chainId}.hypersync.xyz`, apiToken: apiToken ?? '', maxNumRetries: 3 });
};

const formatEvent = (event: Event): Log => ({
  address: getAddress(event.log.address!),
  topics: event.log.topics.filter((topic: unknown) => !isNullish(topic)) as [topic0: Hex, ...rest: Hex[]],
  data: event.log.data as Hex,
  blockNumber: event.log.blockNumber as number,
  transactionHash: event.log.transactionHash as Hash,
  transactionIndex: event.log.transactionIndex as number,
  logIndex: event.log.logIndex as number,
  timestamp: event.block?.timestamp,
});
