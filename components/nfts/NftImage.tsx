'use client';

import { toProxiedImageUrl } from 'lib/nfts/media';
import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

interface Props {
  src?: string;
  alt: string;
  className?: string;
}

// NFT artwork comes from arbitrary hosts and dead IPFS gateways, so a broken image is the normal case
// rather than an exception. This falls back to a neutral placeholder instead of a broken-image icon.
const NftImage = ({ src, alt, className }: Props) => {
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
      src={proxiedSrc}
      alt={alt}
      loading="lazy"
      onError={() => setHasFailed(true)}
      className={cn('object-cover bg-zinc-100 dark:bg-zinc-900', className)}
    />
  );
};

export default NftImage;
