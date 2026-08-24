// Base class for errors that map to a specific HTTP response shape. Route handlers can catch the base
// class and serialize uniformly without needing to know about each subclass.
export abstract class ExportableError extends Error {
  abstract export(): { status: number; body: Record<string, unknown> };
}

export class ApiError extends ExportableError {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: Record<string, unknown> = { message },
  ) {
    super(message);
    this.name = 'ApiError';
  }

  export() {
    return { status: this.status, body: this.body };
  }
}

// Thrown when a token's metadata is missing or malformed in a way that marks it as spam rather than
// as a transient failure. Callers use this to permanently exclude a token instead of retrying it.
export class SpamError extends Error {
  constructor(message = 'Token is marked as spam') {
    super(message);
    this.name = 'SpamError';
  }
}

export const parseErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
};

export const stringifyError = (error: unknown): string => {
  try {
    return JSON.stringify(error, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  } catch {
    return String(error);
  }
};

// The provider returned more logs than it is willing to serve in one response. The fix is always to ask
// for a narrower block range, which is what DivideAndConquerLogsProvider does when it sees this.
export const isLogResponseSizeError = (error?: string | any): boolean => {
  if (!error) return false;

  if (typeof error !== 'string') {
    return isLogResponseSizeError(parseErrorMessage(error)) || isLogResponseSizeError(stringifyError(error));
  }

  const lowercaseMessage = error.toLowerCase();
  if (lowercaseMessage.includes('query returned more than 10000 results')) return true; // Infura
  if (lowercaseMessage.includes('log response size exceeded')) return true; // Alchemy
  if (lowercaseMessage.includes('query timeout exceeded')) return true; // Also Alchemy
  if (lowercaseMessage.includes('query exceeds max results')) return true; // Alchemy (Erigon based nodes)
  if (lowercaseMessage.includes('query timeout occurred')) return true; // Etherscan
  if (lowercaseMessage.includes('queued request timed out')) return true;
  if (lowercaseMessage.includes('query returned more than 1024 results')) return true; // ZERO network
  if (lowercaseMessage.includes('http response body exceeded the size limit')) return true;
  return false;
};

// The provider rejected the request itself because the block range is wider than it allows, without
// having looked at how many logs it would match.
export const isLogRequestSizeError = (error?: string | any): boolean => {
  if (!error) return false;

  if (typeof error !== 'string') {
    return isLogRequestSizeError(parseErrorMessage(error)) || isLogRequestSizeError(stringifyError(error));
  }

  const lowercaseMessage = error.toLowerCase();
  if (lowercaseMessage.includes('query must be smaller than')) return true;
  if (lowercaseMessage.includes('block range is too large')) return true;
  if (lowercaseMessage.includes('block range exceeds')) return true;
  if (lowercaseMessage.includes('block range too wide')) return true;
  if (lowercaseMessage.includes('exceeds the maximum block range')) return true;
  if (lowercaseMessage.includes('eth_getlogs is limited to')) return true;
  if (lowercaseMessage.includes('you can make eth_getlogs requests with up to')) return true;
  if (lowercaseMessage.includes('query exceeds max block range')) return true;
  return false;
};

// The requested range extends past the node's current head, which resolves itself within a block time.
export const isChainHeightError = (error?: string | any): boolean => {
  if (!error) return false;

  if (typeof error !== 'string') {
    return isChainHeightError(parseErrorMessage(error)) || isChainHeightError(stringifyError(error));
  }

  const lowercaseMessage = error.toLowerCase();
  if (lowercaseMessage.includes('block range extends beyond current head')) return true;
  if (lowercaseMessage.includes('block not found for eth_getlogs')) return true;
  if (lowercaseMessage.includes('outside the requested range')) return true; // HyperSync
  if (lowercaseMessage.includes('invalid block range params')) return true;
  return false;
};

export const isRateLimitError = (error?: string | any): boolean => {
  if (!error) return false;

  if (typeof error !== 'string') {
    return isRateLimitError(parseErrorMessage(error)) || isRateLimitError(stringifyError(error));
  }

  const lowercaseMessage = error.toLowerCase();
  if (lowercaseMessage.includes('rate limit')) return true;
  if (lowercaseMessage.includes('too many requests')) return true;
  if (lowercaseMessage.includes('429')) return true;
  return false;
};
