import { getChainApiUrl, SUPPORTED_CHAINS } from 'lib/chains';
import { z } from 'zod';

// Proxies block-explorer requests that the browser cannot make itself.
//
// Explorer CORS policy is wildly inconsistent: Etherscan sends `Access-Control-Allow-Origin: *`, some
// Blockscout instances do too, others send only their own origin, and some send nothing at all. That is not
// something we can predict per chain, so the client tries directly first and falls back to this route for
// whichever hosts turn out to block it. revoke.cash never hits this because it reads logs server-side.
//
// The target URL is resolved here from the chain config rather than accepted from the caller, so this
// cannot be pointed at an arbitrary host.
export const runtime = 'nodejs';

const requestSchema = z.object({
  chainId: z
    .number()
    .int()
    .refine((chainId) => SUPPORTED_CHAINS.includes(chainId as never), 'Unsupported chain id'),
  // Everything the explorer API takes is a flat scalar query string.
  searchParams: z.record(z.string().max(64), z.string().max(1024)),
  // Some Blockscout endpoints live under a sub-path of the same API base (the v2 indexing status, notably).
  path: z
    .string()
    .regex(/^[a-zA-Z0-9/_-]{0,128}$/)
    .optional(),
});

const FETCH_TIMEOUT_MS = 45_000;

export async function POST(request: Request) {
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsedBody.success) {
    return Response.json({ message: 'Invalid request', issues: parsedBody.error.issues }, { status: 400 });
  }

  const { chainId, searchParams, path } = parsedBody.data;
  const apiUrl = getChainApiUrl(chainId as never);

  if (!apiUrl) {
    return Response.json({ message: 'That chain has no explorer API' }, { status: 400 });
  }

  const target = new URL(path ? `${apiUrl}${path.startsWith('/') ? path : `/${path}`}` : apiUrl);
  for (const [key, value] of Object.entries(searchParams)) {
    target.searchParams.set(key, value);
  }

  try {
    const response = await fetch(target, {
      // Server-side fetch does not send fetch-metadata headers, and some explorers sit behind a WAF that
      // answers requests without them with a 502.
      headers: { Accept: 'application/json', 'Sec-Fetch-Site': 'none' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const body = await response.text();

    // The status is passed through rather than normalised, because the client distinguishes a 402/401
    // ("this explorer needs a key") from a generic failure and reports them differently.
    return new Response(body, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Explorer request failed';
    return Response.json({ message }, { status: 502 });
  }
}
