'use client';

import { useAssetCategories } from 'lib/hooks/useAssetCategories';
import { cn } from 'lib/utils/classnames';

interface Props {
  // The asset's identity, followed by every key it could otherwise be found under.
  assetKeys: string[];
  categoryId?: string;
  label: string;
  className?: string;
}

// Files one asset under one category.
//
// Rendered as a plain select rather than as a menu: there are only ever a handful of categories, and the
// row already carries the answer to "which one is this in" without needing to be opened.
const CategorySelect = ({ assetKeys, categoryId, label, className }: Props) => {
  const { categories, setAssetCategory } = useAssetCategories();

  // Nothing to file anything under yet. An empty dropdown on every row is a worse invitation to make a
  // category than the settings page is.
  if (categories.length === 0) return null;

  return (
    <select
      aria-label={`Category for ${label}`}
      value={categoryId ?? ''}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setAssetCategory(assetKeys, event.target.value || undefined)}
      className={cn(
        'max-w-32 text-xs rounded-md border border-zinc-200 dark:border-zinc-800 bg-transparent px-1.5 py-1',
        'text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-700',
        'focus:outline-none focus:ring-1 focus:ring-brand',
        className,
      )}
    >
      <option value="">Uncategorised</option>
      {categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      ))}
    </select>
  );
};

export default CategorySelect;
