import { gatewayCandidates, isGatewayCoolingDown, markGatewayFailed } from 'lib/nfts/gateways';
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
// Per gateway attempt; see the image route for why this is short.
const FETCH_TIMEOUT_MS = 6_000;

export async function POST(request: Request) {
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsedBody.success) {
    return Response.json({ message: 'Invalid request' }, { status: 400 });
  }

  const target = parseSafeUrl(parsedBody.data.url);
  if (!target) {
    return Response.json({ message: 'Refusing to fetch that address' }, { status: 400 });
  }

  // Tried across gateways for IPFS-hosted documents, exactly as the image route does.
  for (const candidate of gatewayCandidates(target)) {
    // A host that just timed out would cost the full timeout again; skip it while it cools down.
    if (isGatewayCoolingDown(candidate)) continue;

    let response: Response;
    try {
      response = await fetchWithGuardedRedirect(candidate, {
        timeoutMs: FETCH_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      });
    } catch {
      // A dead or slow host is sidelined briefly so the next document does not re-pay the timeout.
      markGatewayFailed(candidate);
      continue;
    }

    if (!response.ok) continue;

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return Response.json({ message: 'Metadata document is too large' }, { status: 502 });
    }

    // Content-length is optional, so the body is capped after the fact as well.
    const text = await response.text().catch(() => undefined);
    if (text === undefined || text.length > MAX_RESPONSE_BYTES) {
      return Response.json({ message: 'Metadata document is too large' }, { status: 502 });
    }

    try {
      return Response.json(JSON.parse(text));
    } catch {
      // Garbage JSON is the document's fault, not the gateway's: fall through without blaming the host.
    }
  }

  // Dead metadata hosts are the norm for older NFTs, so this is an expected outcome rather than a fault.
  return Response.json({ message: 'Could not fetch metadata' }, { status: 502 });
}
