import { fetchWithGuardedRedirect, parseSafeUrl } from 'lib/nfts/safe-url';
import { z } from 'zod';

// NFT metadata is hosted wherever the contract's `tokenURI` points, and most of those hosts (ipfs.io very
// much included) send no CORS headers, so the browser cannot read the JSON itself. This proxies the fetch.
//
// The URL comes from on-chain data, which means whoever deployed the contract chooses it, so the guards in
// lib/nfts/safe-url are load-bearing rather than defensive tidiness.
export const runtime = 'nodejs';

const requestSchema = z.object({ url: z.string().url().max(2048) });

const MAX_RESPONSE_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;

export async function POST(request: Request) {
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsedBody.success) {
    return Response.json({ message: 'Invalid request' }, { status: 400 });
  }

  const target = parseSafeUrl(parsedBody.data.url);
  if (!target) {
    return Response.json({ message: 'Refusing to fetch that address' }, { status: 400 });
  }

  try {
    const response = await fetchWithGuardedRedirect(target, {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return Response.json({ message: 'Metadata host returned an error' }, { status: 502 });
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return Response.json({ message: 'Metadata document is too large' }, { status: 502 });
    }

    // Content-length is optional, so the body is capped after the fact as well.
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return Response.json({ message: 'Metadata document is too large' }, { status: 502 });
    }

    return Response.json(JSON.parse(text));
  } catch {
    // Dead metadata hosts are the norm for older NFTs, so this is an expected outcome rather than a fault.
    return Response.json({ message: 'Could not fetch metadata' }, { status: 502 });
  }
}
