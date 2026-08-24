'use client';

import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import Input from 'components/ui/Input';
import { useAssetCategories } from 'lib/hooks/useAssetCategories';
import { CATEGORY_COLORS } from 'lib/portfolio/breakdown';
import { useState } from 'react';

const CategoriesSection = () => {
  const { categories, addCategory, renameCategory, removeCategory } = useAssetCategories();

  const [name, setName] = useState('');
  const [error, setError] = useState<string>();

  const submit = async () => {
    setError(undefined);

    try {
      await addCategory(name);
      setName('');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  return (
    <Card title="Asset categories" bodyClassName="flex flex-col gap-4">
      <p className="text-xs text-zinc-500">
        Your own groupings, for seeing the split between them on the Graphs page. Assign an asset to one from the
        dropdown in its row on the portfolio and NFT tables. Anything you have not filed counts as "Other tokens" or
        "Other NFTs", so there is no need to categorise everything.
      </p>

      <div className="flex items-end gap-3">
        <div className="flex-1 max-w-64">
          <Input
            name="category-name"
            label="New category"
            placeholder="Blue chip"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
        </div>

        <Button variant="primary" size="sm" onClick={submit}>
          Add category
        </Button>
      </div>

      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      {categories.length === 0 ? (
        <p className="text-xs text-zinc-500">No categories yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {categories.map((category, index) => (
            <li key={category.id} className="flex items-center gap-3 py-2">
              {/* The colour this category has on the chart, which comes from its place in this list. */}
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full shrink-0"
                style={{ backgroundColor: CATEGORY_COLORS[index % CATEGORY_COLORS.length] }}
              />

              <input
                aria-label={`Rename ${category.name}`}
                defaultValue={category.name}
                onBlur={(event) => renameCategory(category.id, event.target.value)}
                className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
              />

              <Button variant="danger" size="sm" onClick={() => removeCategory(category.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

export default CategoriesSection;
