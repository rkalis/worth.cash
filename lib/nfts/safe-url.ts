// Guards for server-side fetches of URLs that came from on-chain data.
//
// An NFT contract's `tokenURI` is chosen by whoever deployed it, so any URL derived from it is untrusted
// input that our server would otherwise fetch on request. Without these checks the metadata and image
// proxies would let a malicious contract read from the host's own network, including cloud metadata
// endpoints on 169.254.169.254.

// Hostnames that resolve to the machine running the server or to its private network.
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^\[?::1\]?$/,
  /^0\./,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./, // link-local, including cloud metadata endpoints
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique local IPv6
  /^\[?fe80:/i, // link-local IPv6
];

export const isBlockedUrl = (url: URL): boolean => {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
  return BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(url.hostname));
};

export const parseSafeUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return isBlockedUrl(url) ? undefined : url;
  } catch {
    return undefined;
  }
};

// Follows redirects by hand, re-checking every destination. Letting fetch follow redirects itself would
// allow a public URL to bounce the request onto a private one, defeating the check above.
//
// A short chain rather than a single hop: IPFS gateways redirect path-style URLs to their subdomain form,
// and some public gateways are fronts that bounce through a second gateway before that, so two or three
// legitimate hops are routine.
const MAX_REDIRECTS = 3;

export const fetchWithGuardedRedirect = async (
  target: URL,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> => {
  const { timeoutMs, ...requestInit } = init;
  let currentTarget = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(currentTarget, {
      ...requestInit,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect without a location');

    const redirectTarget = new URL(location, currentTarget);
    if (isBlockedUrl(redirectTarget)) throw new Error('Refusing to follow that redirect');

    currentTarget = redirectTarget;
  }

  throw new Error('Too many redirects');
};
