'use client';

import NftImage from 'components/nfts/NftImage';
import CategorySelect from 'components/portfolio/CategorySelect';
import ChainLogo from 'components/ui/ChainLogo';
import EmptyState from 'components/ui/EmptyState';
import TablePagination from 'components/ui/TablePagination';
import { formatShare } from 'lib/format';
import { useAssetCategories } from 'lib/hooks/useAssetCategories';
import { useCurrency } from 'lib/hooks/useCurrency';
import { usePagination } from 'lib/hooks/usePagination';
import type { AggregatedNftCollection } from 'lib/portfolio/aggregate';

interface Props {
  collections: AggregatedNftCollection[];
  totalValueUsd: number;
}

// The portfolio-page view of NFTs: one row per collection, valued at its floor, with the same shape as the
// token table so the two read as one list. The NFTs page keeps the richer view with artwork per item.
const NftCollectionTable = ({ collections, totalValueUsd }: Props) => {
  const pagination = usePagination(collections);
  const { categories } = useAssetCategories();

  // Same rule as the token table: no column until there is a category to put something in.
  const showCategory = categories.length > 0;
  const { formatValue, formatPrice } = useCurrency();

  if (collections.length === 0) {
    return (
      <EmptyState
        title="No NFTs found"
        description="NFTs are discovered from transfer events, so a wallet that has never received one shows nothing here."
      />
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[580px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
              <th className="text-left font-medium py-2 pl-4 pr-2">Collection</th>
              <th className="text-right font-medium py-2 px-2 hidden sm:table-cell">Floor</th>
              <th className="text-right font-medium py-2 px-2">Items</th>
              <th className="text-right font-medium py-2 px-2">Value</th>
              <th className="text-right font-medium py-2 px-2">Share</th>
              {showCategory ? (
                <th className="text-left font-medium py-2 px-2 pr-4 hidden md:table-cell">Category</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {pagination.pageItems.map((collection) => {
              const share = totalValueUsd > 0 && collection.valueUsd ? (collection.valueUsd / totalValueUsd) * 100 : 0;

              return (
                <tr key={collection.key} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2.5 pl-4 pr-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <NftImage
                        src={collection.imageUrl}
                        alt={collection.name}
                        className="size-5 rounded-md shrink-0"
                      />
                      <span className="font-medium text-sm truncate">{collection.name}</span>
                      <ChainLogo chainId={collection.chainId} size={14} />
                    </div>
                  </td>

                  <td className="py-2.5 px-2 text-right text-sm tabular text-zinc-600 dark:text-zinc-400 hidden sm:table-cell">
                    {collection.floorPriceUsd === null ? '-' : formatPrice(collection.floorPriceUsd)}
                  </td>

                  <td className="py-2.5 px-2 text-right text-sm tabular">{collection.itemCount}</td>

                  <td className="py-2.5 px-2 text-right text-sm font-medium tabular">
                    {formatValue(collection.valueUsd)}
                  </td>

                  <td className="py-2.5 px-2 text-right text-sm tabular text-zinc-500 dark:text-zinc-400">
                    {formatShare(share)}
                  </td>

                  {showCategory ? (
                    <td className="py-2.5 px-2 pr-4 hidden md:table-cell">
                      {/* A collection has no coin id to be identified by, so its own key is the only key it
                          can be filed under. */}
                      <CategorySelect
                        assetKeys={[collection.key]}
                        categoryId={collection.categoryId}
                        label={collection.name}
                      />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TablePagination pagination={pagination} />
    </>
  );
};

export default NftCollectionTable;
