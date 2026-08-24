import { OPENSEA_CHAIN_SLUGS } from 'lib/chains/opensea';
import { OPENSEA_API_BASE_URL } from 'lib/constants';
import { z } from 'zod';

// OpenSea does not send CORS headers and requires an API key on every request, so the browser cannot call
// it directly. As with the exchange routes, the key travels per request and is never stored here.
export const runtime = 'nodejs';

const supportedChainSlugs = Object.values(OPENSEA_CHAIN_SLUGS);

// Every path segment is validated rather than accepted verbatim, so this cannot be used to reach an
// arbitrary OpenSea endpoint (or, through a crafted slug, some other host entirely).
const requestSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('contract'),
    chain: z.string().refine((chain) => supportedChainSlugs.includes(chain), 'Unsupported OpenSea chain'),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a contract address'),
  }),
  z.object({
    operation: z.literal('stats'),
    slug: z.string().regex(/^[a-zA-Z0-9-_]{1,128}$/, 'Expected a collection slug'),
  }),
  z.object({
    operation: z.literal('collection'),
    slug: z.string().regex(/^[a-zA-Z0-9-_]{1,128}$/, 'Expected a collection slug'),
  }),
]);

export async function POST(request: Request) {
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsedBody.success) {
    return Response.json({ message: 'Invalid request', issues: parsedBody.error.issues }, { status: 400 });
  }

  const apiKey = request.headers.get('x-opensea-key');

  if (!apiKey) {
    return Response.json({ message: 'Missing OpenSea API key' }, { status: 401 });
  }

  const path = buildPath(parsedBody.data);

  try {
    const response = await fetch(`${OPENSEA_API_BASE_URL}${path}`, {
      headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
    });

    // A collection that OpenSea does not know about is an expected outcome, not a failure: most NFTs on
    // most chains are not listed there. The caller treats it as "no floor price available".
    if (response.status === 404) {
      return Response.json({ message: 'Not found on OpenSea' }, { status: 404 });
    }

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return Response.json({ message: 'OpenSea rejected the request', detail: body }, { status: response.status });
    }

    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenSea request failed';
    return Response.json({ message }, { status: 502 });
  }
}

const buildPath = (request: z.infer<typeof requestSchema>): string => {
  if (request.operation === 'contract') {
    return `/chain/${request.chain}/contract/${request.address}`;
  }

  if (request.operation === 'stats') {
    return `/collections/${request.slug}/stats`;
  }

  return `/collections/${request.slug}`;
};
