'use client';

import { toProxiedImageUrl } from 'lib/nfts/media';
import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

interface Props {
  src?: string;
  alt: string;
  className?: string;
}

// How many fresh attempts a failed image gets, and how long to wait before each.
//
// One retry, after a pause: the proxy sidelines a dead gateway the first time it times out, so an image
// that failed in the first burst usually succeeds seconds later through the next gateway. More than one
// retry just hammers hosts that have already said no.
const RETRY_LIMIT = 1;
const RETRY_DELAY_MS = 5_000;

// NFT artwork comes from arbitrary hosts and dead IPFS gateways, so a broken image is the normal case
// rather than an exception. This falls back to a neutral placeholder instead of a broken-image icon.
const NftImage = ({ src, alt, className }: Props) => {
  const [attempt, setAttempt] = useState(0);
  const [hasFailed, setHasFailed] = useState(false);
  const proxiedSrc = toProxiedImageUrl(src);

  if (!proxiedSrc || hasFailed) {
    return (
      <div
        className={cn('flex items-center justify-center bg-zinc-100 dark:bg-zinc-900 text-zinc-400 text-xs', className)}
        role="img"
        aria-label={alt}
      >
        {alt.slice(0, 2).toUpperCase()}
      </div>
    );
  }

  return (
    <img
      // The attempt number busts the browser's memory of the failed response; the proxy itself caches
      // successes hard, so a retry that succeeds costs one request.
      src={attempt === 0 ? proxiedSrc : `${proxiedSrc}&retry=${attempt}`}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (attempt >= RETRY_LIMIT) {
          setHasFailed(true);
          return;
        }

        setTimeout(() => setAttempt(attempt + 1), RETRY_DELAY_MS);
      }}
      className={cn('object-cover bg-zinc-100 dark:bg-zinc-900', className)}
    />
  );
};

export default NftImage;
