'use client';

import { useEffect, useMemo, useState } from 'react';

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

// Tables at or below this size gain nothing from pagination, so the controls hide themselves.
export const PAGINATION_ROW_THRESHOLD = 20;

export interface Pagination<T> {
  pageItems: T[];
  pageIndex: number;
  pageCount: number;
  pageSize: number;
  totalRows: number;
  // The 1-indexed range currently on screen, for the "showing x to y of z" readout.
  firstRowOnPage: number;
  lastRowOnPage: number;
  canPreviousPage: boolean;
  canNextPage: boolean;
  setPageIndex: (pageIndex: number) => void;
  setPageSize: (pageSize: number) => void;
  isPaginated: boolean;
}

// Client-side pagination over an already-materialised list.
//
// Everything the portfolio renders is derived from IndexedDB and already in memory, so paging is a matter of
// slicing rather than fetching. The page is deliberately not part of the URL: it is a view detail people
// expect to reset, not something worth restoring on reload.
export const usePagination = <T>(items: T[], initialPageSize: number = PAGE_SIZE_OPTIONS[1]): Pagination<T> => {
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(initialPageSize);

  const totalRows = items.length;
  const pageCount = Math.max(Math.ceil(totalRows / pageSize), 1);

  // A sync can shrink the list under a reader who is on a later page. Clamping rather than resetting to the
  // first page keeps them as close as possible to where they were.
  useEffect(() => {
    if (pageIndex > pageCount - 1) setPageIndex(pageCount - 1);
  }, [pageIndex, pageCount]);

  const pageItems = useMemo(() => {
    const start = pageIndex * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, pageIndex, pageSize]);

  return {
    pageItems,
    pageIndex,
    pageCount,
    pageSize,
    totalRows,
    firstRowOnPage: Math.min(pageIndex * pageSize + 1, totalRows),
    lastRowOnPage: Math.min((pageIndex + 1) * pageSize, totalRows),
    canPreviousPage: pageIndex > 0,
    canNextPage: pageIndex < pageCount - 1,
    setPageIndex,
    setPageSize: (nextPageSize: number) => {
      // Jumping to the page holding the first row currently on screen keeps the reader's place roughly put
      // instead of throwing them back to the top.
      const firstVisibleRow = pageIndex * pageSize;
      setPageSize(nextPageSize);
      setPageIndex(Math.floor(firstVisibleRow / nextPageSize));
    },
    isPaginated: totalRows > PAGINATION_ROW_THRESHOLD,
  };
};
