export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000' as const;
export const ADDRESS_ZERO_PADDED = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

// Canonical Multicall3 deployment, used on nearly every chain. Chains that deployed it at a different
// address override this in their chain config.
export const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

// The pseudo-address we use to represent a chain's native token (ETH, BNB, POL, ...) so that native
// balances can live in the same tables and aggregations as ERC20 balances.
export const NATIVE_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;

// The revoke.cash whois dataset, which is where token logos and curated spam flags come from.
export const WHOIS_BASE_URL = 'https://whois.revoke.cash/generated';

export const COINGECKO_PRO_API_BASE_URL = 'https://pro-api.coingecko.com/api/v3';
export const COINGECKO_PUBLIC_API_BASE_URL = 'https://api.coingecko.com/api/v3';
export const COINBASE_API_BASE_URL = 'https://api.coinbase.com';
export const KRAKEN_API_BASE_URL = 'https://api.kraken.com';
