// IPFS content is addressed by hash, so any gateway can serve it and no one gateway deserves to be a
// single point of failure. ipfs.io in particular rate-limits hard enough that a page of NFT artwork
// reliably sees 429s partway through.

const IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];

// The content path behind a gateway URL, so the same content can be requested from a different gateway.
//
// Matched on the /ipfs/<cid> path shape rather than on a hostname list: any host serving that path is a
// gateway, including ones this app never wrote, since collection metadata often hardcodes its own.
const IPFS_PATH_PATTERN = /\/ipfs\/((?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(?:\/[^?#]*)?)/;

export const extractIpfsPath = (url: URL): string | undefined => {
  const match = url.pathname.match(IPFS_PATH_PATTERN);
  return match ? match[1] : undefined;
};

// Every URL worth trying for one piece of content, the requested one first.
//
// For IPFS content that is the requested gateway followed by the alternates; for anything else there is
// only the one host that has it, so the list is just the URL itself.
export const gatewayCandidates = (url: URL): URL[] => {
  const ipfsPath = extractIpfsPath(url);
  if (!ipfsPath) return [url];

  const alternates = IPFS_GATEWAYS.map((gateway) => new URL(`${gateway}${ipfsPath}`)).filter(
    (candidate) => candidate.href !== url.href,
  );

  return [url, ...alternates];
};

// A gateway that just timed out is overwhelmingly likely to time out again on the next image, and paying
// the full timeout once per image is what makes a page of artwork crawl. One failure sidelines the host
// briefly; nothing is remembered for long, because gateway weather changes by the hour.
const gatewayDownUntil = new Map<string, number>();
const GATEWAY_COOLDOWN_MS = 60_000;

export const markGatewayFailed = (url: URL): void => {
  gatewayDownUntil.set(url.hostname, Date.now() + GATEWAY_COOLDOWN_MS);
};

export const isGatewayCoolingDown = (url: URL): boolean => (gatewayDownUntil.get(url.hostname) ?? 0) > Date.now();
