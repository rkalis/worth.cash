'use client';

import { db } from 'lib/db';
import type { AggregatedToken } from 'lib/portfolio/aggregate';
import { useCallback } from 'react';

// Manual show/hide decisions. These are stored as explicit rows rather than as an absence, because "the
// user un-hid this" has to survive a later re-run of the spam heuristics that would otherwise re-hide it.
export const useTokenOverrides = () => {
  // Written against the position's stable identity and against every key it could otherwise be found under,
  // all with the same value.
  //
  // Writing the copies rather than deleting them is what makes this survivable. A row is keyed by its coin
  // id, and a coin id can disappear: a metadata refresh that fails to resolve one drops the row back to a
  // per-contract key. If the migration had deleted that key, the user's decision would vanish with it, and
  // a position they had hidden would quietly reappear in their portfolio.
  const setPositionHidden = useCallback(async (token: AggregatedToken, hidden: boolean) => {
    const updatedAt = Date.now();
    const rows = [token.overrideKey, ...token.supersededOverrideKeys].map((id) => ({
      id,
      hidden: (hidden ? 1 : 0) as 0 | 1,
      updatedAt,
    }));

    await db.tokenOverrides.bulkPut(rows);
  }, []);

  return { setPositionHidden };
};
