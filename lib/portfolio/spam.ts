import type { StoredToken } from 'lib/db/schema';

export interface SpamVerdict {
  isSpam: boolean;
  reason?: string;
}

// Airdropped spam tokens overwhelmingly advertise a website in their name or symbol, because the token
// exists to get you to visit it. This is the single highest-signal heuristic.
const URL_PATTERN = /(https?:\/\/|www\.|\.com|\.io|\.xyz|\.org|\.net|\.finance|\.app|\.site|\.vip|\.top|\.cc)\b/i;

// Bait phrasing. Matched as whole words so that legitimate tokens are not caught by a substring, which is
// what would otherwise happen to names like "Reward Token" vs "Claimable Rewards".
const BAIT_PATTERN =
  /\b(claim|claiming|airdrop|reward[s]?|voucher|giveaway|winner|congratulation[s]?|visit|redeem|bonus|free)\b/i;

// Symbols are short by convention. Anything this long is a sentence, not a ticker.
const MAX_REASONABLE_SYMBOL_LENGTH = 20;
const MAX_REASONABLE_NAME_LENGTH = 80;

// Characters outside the ranges a real ticker uses. Spam tokens use lookalike glyphs and emoji both to
// impersonate real projects and to slip past naive string matching.
const SUSPICIOUS_CHARACTER_PATTERN = /[ɐ-ʯͰ-ϿЀ-ӿḀ-ỿ -⯿\u{1F000}-\u{1FAFF}]/u;

// Characters that read as a full stop but are not one. Scam tokens use these to smuggle a domain past a
// naive check for ".com": `USD-SWAP\u2024COM` looks exactly like a URL to a human and matches nothing to a
// regex. Unicode normalisation folds some of them, but by no means all, so the rest are listed explicitly.
const DOT_LOOKALIKE_CHARACTERS = '\u2024\uFF0E\u3002\u02D9\uA4F8\u0701\u2E33\u00B7\u2022\u2027\u30FB\uFF65';

// Two copies on purpose: a global regex carries a mutable lastIndex, so reusing one for both `replace` and
// `test` makes the test alternate between true and false on identical input.
const DOT_LOOKALIKES_GLOBAL = new RegExp(`[${DOT_LOOKALIKE_CHARACTERS}]`, 'g');
const DOT_LOOKALIKES = new RegExp(`[${DOT_LOOKALIKE_CHARACTERS}]`);

// Folds a name or symbol down to something the patterns below can be trusted against: compatibility
// normalised, dot-lookalikes turned into real dots, and combining marks stripped so that an accent cannot
// be used to break a word apart.
const normaliseForMatching = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(DOT_LOOKALIKES_GLOBAL, '.')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

// Classifies a token as spam from its metadata alone.
//
// This is deliberately conservative in one direction: a false positive hides something the user owns, which
// is worse than a false negative that leaves one more row of noise on screen. Anything it flags is hidden
// rather than deleted, stays visible under "hidden tokens", and can be un-hidden permanently by the user.
export const classifyTokenSpam = (token: Pick<StoredToken, 'symbol' | 'name' | 'decimals'>): SpamVerdict => {
  const symbol = token.symbol?.trim() ?? '';
  const name = token.name?.trim() ?? '';
  const rawCombined = `${symbol} ${name}`.trim();
  const combined = normaliseForMatching(rawCombined);

  if (combined === '') {
    return { isSpam: true, reason: 'No readable name or symbol' };
  }

  if (URL_PATTERN.test(combined)) {
    return { isSpam: true, reason: 'Name or symbol advertises a website' };
  }

  if (BAIT_PATTERN.test(combined)) {
    return { isSpam: true, reason: 'Name or symbol uses airdrop bait wording' };
  }

  if (symbol.length > MAX_REASONABLE_SYMBOL_LENGTH) {
    return { isSpam: true, reason: 'Symbol is implausibly long' };
  }

  if (name.length > MAX_REASONABLE_NAME_LENGTH) {
    return { isSpam: true, reason: 'Name is implausibly long' };
  }

  if (SUSPICIOUS_CHARACTER_PATTERN.test(rawCombined) || DOT_LOOKALIKES.test(rawCombined)) {
    return { isSpam: true, reason: 'Name or symbol uses lookalike or decorative characters' };
  }

  // A fungible token whose decimals we could not read is either not an ERC20 at all or deliberately
  // malformed. Either way we cannot compute a real balance from it.
  if (token.decimals === undefined || token.decimals === null || token.decimals > 36) {
    return { isSpam: true, reason: 'Token does not report usable decimals' };
  }

  return { isSpam: false };
};
