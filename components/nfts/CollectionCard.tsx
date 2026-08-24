'use client';

import NftImage from 'components/nfts/NftImage';
import Badge from 'components/ui/Badge';
import ChainLogo from 'components/ui/ChainLogo';
import { shortenAddress } from 'lib/format';
import { useCurrency } from 'lib/hooks/useCurrency';
import type { AggregatedNftCollection } from 'lib/portfolio/aggregate';
import { useState } from 'react';

interface Props {
  collection: AggregatedNftCollection;
}

// How many items to render before collapsing the rest behind a toggle. A single collection can hold
// hundreds of items, and mounting every image at once makes the page unusable.
const PREVIEW_ITEM_COUNT = 12;

const CollectionCard = ({ collection }: Props) => {
  const [showAllItems, setShowAllItems] = useState(false);
  const { formatValue, formatPrice } = useCurrency();

  const items = showAllItems ? collection.items : collection.items.slice(0, PREVIEW_ITEM_COUNT);
  const hiddenItemCount = collection.items.length - items.length;

  return (
    <section className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
      <header className="flex items-center gap-3 p-3 border-b border-zinc-200 dark:border-zinc-800">
        <NftImage src={collection.imageUrl} alt={collection.name} className="size-10 rounded-lg shrink-0" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold truncate">{collection.name}</h3>
            <ChainLogo chainId={collection.chainId} size={14} />
          </div>
          <div className="text-xs text-zinc-500 truncate">
            {collection.itemCount} item{collection.itemCount === 1 ? '' : 's'} · {shortenAddress(collection.address)}
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="text-sm font-medium tabular">{formatValue(collection.valueUsd)}</div>
          <div className="text-[11px] text-zinc-500 tabular">
            {collection.floorPriceUsd === null ? (
              'No floor price'
            ) : (
              <>
                {formatPrice(collection.floorPriceUsd)} floor
                {collection.floorPriceSource ? (
                  <span className="text-zinc-400">
                    {' '}
                    · {collection.floorPriceSource === 'coingecko' ? 'CoinGecko' : 'OpenSea'}
                  </span>
                ) : null}
              </>
            )}
          </div>
        </div>
      </header>

      <div className="p-3">
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {items.map((item) => (
            <div key={item.id} className="group relative">
              <NftImage
                src={item.imageUrl}
                alt={item.name ?? `#${item.tokenId}`}
                className="w-full aspect-square rounded-lg"
              />
              {Number(item.amount) > 1 ? (
                <Badge className="absolute top-1 right-1 bg-black/70 text-white dark:bg-white/80 dark:text-black">
                  x{item.amount}
                </Badge>
              ) : null}
              <div className="mt-1 text-[11px] text-zinc-500 truncate" title={item.name ?? `#${item.tokenId}`}>
                {item.name ?? `#${truncateTokenId(item.tokenId)}`}
              </div>
            </div>
          ))}
        </div>

        {hiddenItemCount > 0 || showAllItems ? (
          <button
            type="button"
            onClick={() => setShowAllItems(!showAllItems)}
            className="mt-3 text-xs text-zinc-500 hover:text-black dark:hover:text-white"
          >
            {showAllItems ? 'Show fewer' : `Show ${hiddenItemCount} more`}
          </button>
        ) : null}
      </div>
    </section>
  );
};

// Token ids can be full uint256 values, which would otherwise blow out the layout.
const truncateTokenId = (tokenId: string): string => (tokenId.length > 10 ? `${tokenId.slice(0, 8)}...` : tokenId);

export default CollectionCard;
