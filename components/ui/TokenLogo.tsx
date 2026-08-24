'use client';

import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

interface Props {
  src?: string;
  symbol: string;
  size?: number;
  className?: string;
}

// A token's own logo, falling back to its initial on a plain grey circle when there is none.
//
// The fallback is deliberately not the chain's logo. Standing a chain logo in for a missing token icon makes
// every ERC20 on Ethereum look like ETH, which is worse than showing nothing: it is not a placeholder, it is
// a wrong answer. An initial says only what the row already says, so it can be read as a placeholder while
// still giving each token a distinguishable shape in a long list.
const TokenLogo = ({ src, symbol, size = 20, className }: Props) => {
  const [hasFailed, setHasFailed] = useState(false);

  if (!src || hasFailed) {
    return (
      <span
        role="img"
        aria-label={symbol}
        title={symbol}
        className={cn(
          'inline-flex items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-800 shrink-0 select-none',
          'font-medium leading-none text-zinc-500 dark:text-zinc-400',
          className,
        )}
        // Scaled to the circle rather than fixed, since the same component renders at 14px in a breakdown
        // row and at 40px on a detail card.
        style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
      >
        {getInitial(symbol)}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={symbol}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setHasFailed(true)}
      className={cn('rounded-full shrink-0 object-cover bg-white', className)}
      style={{ width: size, height: size }}
    />
  );
};

// The first letter or digit, uppercased. Symbols routinely open with a sigil or an emoji ("$PEPE", "🎁 FREE"),
// and a circle containing "$" or half a surrogate pair identifies nothing, so those are skipped over.
const getInitial = (symbol: string): string => {
  const firstAlphanumeric = symbol.match(/[\p{L}\p{N}]/u)?.[0];
  return (firstAlphanumeric ?? symbol.trim().charAt(0)).toUpperCase();
};

export default TokenLogo;
