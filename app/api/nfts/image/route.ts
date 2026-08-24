import { fetchWithGuardedRedirect, parseSafeUrl } from 'lib/nfts/safe-url';

// Serves NFT artwork through our own origin.
//
// Artwork lives on arbitrary hosts and IPFS gateways, and browsers block a surprising share of them when
// loaded cross-origin: some gateways set a restrictive Cross-Origin-Resource-Policy, others serve plain
// http. Proxying makes every image same-origin, which sidesteps the entire class of problem rather than
// chasing whichever gateway happens to be permissive this month.
export const runtime = 'nodejs';

// Only real image types are passed through, so this cannot be used to serve arbitrary content from our own
// origin, which would otherwise be an HTML-injection vector against this app.
const ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml'];

const MAX_IMAGE_BYTES = 12_000_000;
const FETCH_TIMEOUT_MS = 15_000;

export async function GET(request: Request) {
  const requestedUrl = new URL(request.url).searchParams.get('url');

  if (!requestedUrl) {
    return new Response('Missing url', { status: 400 });
  }

  const target = parseSafeUrl(requestedUrl);
  if (!target) {
    return new Response('Refusing to fetch that address', { status: 400 });
  }

  try {
    const response = await fetchWithGuardedRedirect(target, {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { Accept: 'image/*' },
    });

    if (!response.ok || !response.body) {
      return new Response('Image host returned an error', { status: 502 });
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return new Response('Unsupported image type', { status: 415 });
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      return new Response('Image is too large', { status: 502 });
    }

    return new Response(response.body, {
      headers: {
        'Content-Type': contentType,
        // NFT artwork is immutable once minted, so it can be cached hard.
        'Cache-Control': 'public, max-age=86400, immutable',
        // An SVG from an untrusted host can carry script, so it is locked down rather than trusted.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Could not fetch image', { status: 502 });
  }
}
