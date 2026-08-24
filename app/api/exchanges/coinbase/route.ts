import crypto from 'node:crypto';
import { z } from 'zod';

// Coinbase requires every request to carry a short-lived JWT signed with the account's private key. Signing
// needs Node's crypto, and the key must never be exposed to a browser tab, so the whole exchange call is
// made from here. The credentials arrive with each request and are never persisted server-side.
export const runtime = 'nodejs';

const COINBASE_API_HOST = 'api.coinbase.com';

// Only these operations can be performed. The route deliberately does not accept an arbitrary path, so it
// cannot be turned into a general-purpose proxy for the caller's credentials.
const OPERATIONS = {
  accounts: { method: 'GET', path: '/api/v3/brokerage/accounts' },
  // The v2 API is the only one that exposes a per-account transaction history, which is what the weekly
  // chart's backfill reconstructs past balances from.
  v2Accounts: { method: 'GET', path: '/v2/accounts' },
  v2Transactions: { method: 'GET', path: '/v2/accounts/{accountId}/transactions' },
} as const;

const requestSchema = z.object({
  operation: z.enum(['accounts', 'v2Accounts', 'v2Transactions']),
  // Only ever substituted into the `{accountId}` placeholder, and constrained so it cannot inject a path.
  accountId: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  query: z.record(z.string(), z.string()).optional(),
});

export async function POST(request: Request) {
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsedBody.success) {
    return Response.json({ message: 'Invalid request', issues: parsedBody.error.issues }, { status: 400 });
  }

  const keyName = request.headers.get('x-coinbase-key-name');
  const privateKey = request.headers.get('x-coinbase-private-key');

  if (!keyName || !privateKey) {
    return Response.json({ message: 'Missing Coinbase API credentials' }, { status: 401 });
  }

  const { operation, accountId, query } = parsedBody.data;
  const definition = OPERATIONS[operation];

  if (definition.path.includes('{accountId}') && !accountId) {
    return Response.json({ message: 'This operation requires an account id' }, { status: 400 });
  }

  const path = definition.path.replace('{accountId}', accountId ?? '');
  const url = new URL(`https://${COINBASE_API_HOST}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  try {
    // The JWT's `uri` claim covers method, host, and path but not the query string, which is why the query
    // is applied to the URL only after the token is built.
    const token = createCoinbaseJwt(keyName, privateKey, `${definition.method} ${COINBASE_API_HOST}${path}`);

    const response = await fetch(url, {
      method: definition.method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return Response.json({ message: 'Coinbase rejected the request', detail: body }, { status: response.status });
    }

    return Response.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Coinbase request failed';
    return Response.json({ message }, { status: 502 });
  }
}

// Builds the ES256 or EdDSA JWT that Coinbase's CDP keys authenticate with.
const createCoinbaseJwt = (keyName: string, privateKeyMaterial: string, uri: string): string => {
  const { key, algorithm } = importPrivateKey(privateKeyMaterial);

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = {
    alg: algorithm,
    kid: keyName,
    typ: 'JWT',
    // Coinbase requires a unique nonce per token to prevent replay.
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  // Coinbase rejects tokens with a lifetime longer than two minutes.
  const payload = { iss: 'cdp', sub: keyName, nbf: issuedAt, exp: issuedAt + 120, uri };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;

  // ES256 signatures must be the raw r||s pair rather than Node's default DER encoding, which is what
  // `ieee-p1363` produces. Ed25519 has no such distinction.
  const signature =
    algorithm === 'ES256'
      ? crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
      : crypto.sign(null, Buffer.from(signingInput), key);

  return `${signingInput}.${base64UrlEncodeBuffer(signature)}`;
};

// Coinbase issues CDP keys in two shapes: an EC private key in PEM form, and a base64 Ed25519 key.
const importPrivateKey = (privateKeyMaterial: string): { key: crypto.KeyObject; algorithm: 'ES256' | 'EdDSA' } => {
  const normalised = privateKeyMaterial.replace(/\\n/g, '\n').trim();

  if (normalised.includes('BEGIN') && normalised.includes('PRIVATE KEY')) {
    return { key: crypto.createPrivateKey(normalised), algorithm: 'ES256' };
  }

  // The Ed25519 form is 64 raw bytes: a 32-byte seed followed by the 32-byte public key. Node can only
  // import a PKCS8 structure, so the seed is wrapped in the fixed PKCS8 prefix for Ed25519.
  const rawKey = Buffer.from(normalised, 'base64');
  if (rawKey.length !== 64 && rawKey.length !== 32) {
    throw new Error('Unrecognised Coinbase private key format');
  }

  const seed = rawKey.subarray(0, 32);
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const key = crypto.createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  });

  return { key, algorithm: 'EdDSA' };
};

const base64UrlEncode = (value: string): string => base64UrlEncodeBuffer(Buffer.from(value));

const base64UrlEncodeBuffer = (value: Buffer): string =>
  value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
