// Turns the many URI schemes NFT metadata uses into something a browser can actually load.

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const ARWEAVE_GATEWAY = 'https://arweave.net/';

export const resolveMediaUrl = (uri: string | undefined): string | undefined => {
  if (!uri) return undefined;

  const trimmed = uri.trim();
  if (trimmed === '') return undefined;

  if (trimmed.startsWith('ipfs://')) {
    // Both `ipfs://<cid>` and the legacy `ipfs://ipfs/<cid>` appear in the wild.
    return `${IPFS_GATEWAY}${trimmed.replace(/^ipfs:\/\/(ipfs\/)?/, '')}`;
  }

  if (trimmed.startsWith('ar://')) {
    return `${ARWEAVE_GATEWAY}${trimmed.slice('ar://'.length)}`;
  }

  // Data URIs are already self-contained, and https URLs need no rewriting.
  if (trimmed.startsWith('data:') || trimmed.startsWith('https://')) return trimmed;

  // Plain http is upgraded, since the app itself is served over https and the image would be blocked.
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice('http://'.length)}`;

  // A bare CID with no scheme is common enough to be worth handling.
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58})/.test(trimmed)) return `${IPFS_GATEWAY}${trimmed}`;

  return undefined;
};

// ERC1155 metadata URIs may contain an `{id}` placeholder that the client is expected to substitute with
// the token id as a zero-padded, lowercase, 64-character hex string.
export const substituteTokenId = (uri: string, tokenId: string): string => {
  if (!uri.includes('{id}')) return uri;

  try {
    const paddedId = BigInt(tokenId).toString(16).padStart(64, '0');
    return uri.replaceAll('{id}', paddedId);
  } catch {
    return uri;
  }
};

// Metadata is occasionally inlined as a base64 or URL-encoded data URI rather than hosted.
export const parseDataUriJson = (uri: string): Record<string, unknown> | undefined => {
  if (!uri.startsWith('data:')) return undefined;

  try {
    const payload = uri.slice(uri.indexOf(',') + 1);
    const json = uri.includes(';base64,') ? atob(payload) : decodeURIComponent(payload);
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

// Rewrites a resolved artwork URL to load through our own origin.
//
// Remote hosts are proxied because a meaningful share of gateways refuse to be embedded cross-origin. Data
// URIs are already self-contained and same-origin by nature, so they are passed through untouched.
export const toProxiedImageUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  if (url.startsWith('data:')) return url;

  return `/api/nfts/image?url=${encodeURIComponent(url)}`;
};
