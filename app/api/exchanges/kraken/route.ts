import crypto from 'node:crypto';
import { z } from 'zod';

// Kraken signs private requests with an HMAC over the request path and body, keyed by the base64-decoded
// API secret. As with Coinbase, that has to happen server-side, and the credentials arrive per request
// rather than being stored here.
export const runtime = 'nodejs';

const KRAKEN_API_HOST = 'https://api.kraken.com';

// A strict allowlist of read-only endpoints. Kraken's private API also contains order placement and
// withdrawal endpoints, and this route must be incapable of reaching them regardless of what it is asked for.
const OPERATIONS = {
  balance: '/0/private/Balance',
  ledgers: '/0/private/Ledgers',
} as const;

// Kraken requires each request's nonce to be strictly greater than the previous one for the same key. A
// bare millisecond timestamp is not enough, because two requests issued in the same millisecond would tie
// and the second would be rejected. This counter guarantees monotonicity within the process.
let lastIssuedNonce = 0;

const nextNonce = (): string => {
  lastIssuedNonce = Math.max(Date.now(), lastIssuedNonce + 1);
  return String(lastIssuedNonce);
};

const requestSchema = z.object({
  operation: z.enum(['balance', 'ledgers']),
  // Forwarded as form parameters. Constrained to simple scalars so nothing structural can be smuggled in.
  parameters: z.record(z.string().regex(/^[a-zA-Z]{1,20}$/), z.string().max(64)).optional(),
});

export async function POST(request: Request) {
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsedBody.success) {
    return Response.json({ message: 'Invalid request', issues: parsedBody.error.issues }, { status: 400 });
  }

  const apiKey = request.headers.get('x-kraken-api-key');
  const apiSecret = request.headers.get('x-kraken-api-secret');

  if (!apiKey || !apiSecret) {
    return Response.json({ message: 'Missing Kraken API credentials' }, { status: 401 });
  }

  const path = OPERATIONS[parsedBody.data.operation];

  const nonce = nextNonce();
  const body = new URLSearchParams({ nonce, ...(parsedBody.data.parameters ?? {}) });

  try {
    const signature = createKrakenSignature(path, nonce, body.toString(), apiSecret);

    const response = await fetch(`${KRAKEN_API_HOST}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': apiKey,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as { error?: string[]; result?: unknown };

    // Kraken reports application errors as a 200 with a populated `error` array, so a bad key looks like a
    // success unless we check the body.
    if (payload.error && payload.error.length > 0) {
      return Response.json({ message: payload.error.join(', ') }, { status: 400 });
    }

    if (!response.ok) {
      return Response.json({ message: 'Kraken rejected the request' }, { status: response.status });
    }

    return Response.json({ result: payload.result ?? {} });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kraken request failed';
    return Response.json({ message }, { status: 502 });
  }
}

// API-Sign = HMAC-SHA512(base64Decode(secret), path + SHA256(nonce + postData)), base64 encoded.
const createKrakenSignature = (path: string, nonce: string, postData: string, apiSecret: string): string => {
  const nonceHash = crypto
    .createHash('sha256')
    .update(nonce + postData)
    .digest();
  const message = Buffer.concat([Buffer.from(path), nonceHash]);

  return crypto.createHmac('sha512', Buffer.from(apiSecret, 'base64')).update(message).digest('base64');
};
