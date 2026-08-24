'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from 'lib/db';
import type { StoredAssetCategory } from 'lib/db/schema';
import { useCallback } from 'react';

// Hoisted so the pre-resolution value keeps a stable identity across renders. An inline literal makes
// useLiveQuery hand back a new snapshot every render, which useSyncExternalStore reads as a state change.
const NO_CATEGORIES: StoredAssetCategory[] = [];

// The user's own groupings, and which asset sits in which.
//
// An asset belongs to at most one category. Overlapping groups would make a split that does not add up to
// the portfolio, and the entire point of the split is to be read as shares of the whole.
export const useAssetCategories = () => {
  const categories = useLiveQuery(() => db.assetCategories.orderBy('sortIndex').toArray(), [], NO_CATEGORIES);

  const addCategory = useCallback(async (name: string): Promise<string> => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('A category needs a name.');

    const existing = await db.assetCategories.toArray();
    if (existing.some((category) => category.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error('There is already a category with that name.');
    }

    const id = crypto.randomUUID();

    await db.assetCategories.put({
      id,
      name: trimmed,
      // Appended rather than inserted, so adding one never renumbers the others and never changes the
      // colour of a category already on the chart.
      sortIndex: existing.reduce((highest, category) => Math.max(highest, category.sortIndex), -1) + 1,
      createdAt: Date.now(),
    });

    return id;
  }, []);

  const renameCategory = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    await db.assetCategories.update(id, { name: trimmed });
  }, []);

  // Deleting takes the assignments with it. Leaving them would file assets under a category that no longer
  // exists, and re-creating a category with the same name would silently inherit them.
  const removeCategory = useCallback(async (id: string) => {
    await db.transaction('rw', [db.assetCategories, db.categoryAssignments], async () => {
      await db.assetCategories.delete(id);
      await db.categoryAssignments.where('categoryId').equals(id).delete();
    });
  }, []);

  // Assigns one asset. `assetKeys` is the asset's identity plus every key it could otherwise be found
  // under, written together for the same reason a hide decision is: an asset's key changes when its coin id
  // appears or disappears, and a decision recorded against only the current one would be lost with it.
  const setAssetCategory = useCallback(async (assetKeys: string[], categoryId: string | undefined) => {
    if (assetKeys.length === 0) return;

    await db.transaction('rw', [db.categoryAssignments], async () => {
      if (!categoryId) {
        await db.categoryAssignments.bulkDelete(assetKeys);
        return;
      }

      const updatedAt = Date.now();
      await db.categoryAssignments.bulkPut(assetKeys.map((id) => ({ id, categoryId, updatedAt })));
    });
  }, []);

  return { categories, addCategory, renameCategory, removeCategory, setAssetCategory };
};
