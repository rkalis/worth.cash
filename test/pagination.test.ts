// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { PAGINATION_ROW_THRESHOLD, usePagination } from 'lib/hooks/usePagination';
import { describe, expect, it } from 'vitest';

const rows = (count: number) => Array.from({ length: count }, (_, index) => index);

describe('usePagination', () => {
  it('slices the list down to one page', () => {
    const { result } = renderHook(() => usePagination(rows(60), 25));

    expect(result.current.pageItems).toHaveLength(25);
    expect(result.current.pageItems[0]).toBe(0);
    expect(result.current.pageCount).toBe(3);
    expect(result.current.totalRows).toBe(60);
  });

  it('reports the visible range for the showing readout', () => {
    const { result } = renderHook(() => usePagination(rows(60), 25));

    expect([result.current.firstRowOnPage, result.current.lastRowOnPage]).toEqual([1, 25]);

    act(() => result.current.setPageIndex(2));

    // The final page is short, so the range stops at the true total rather than at the page boundary.
    expect([result.current.firstRowOnPage, result.current.lastRowOnPage]).toEqual([51, 60]);
    expect(result.current.pageItems).toHaveLength(10);
  });

  it('knows when it is at either end', () => {
    const { result } = renderHook(() => usePagination(rows(60), 25));

    expect(result.current.canPreviousPage).toBe(false);
    expect(result.current.canNextPage).toBe(true);

    act(() => result.current.setPageIndex(2));

    expect(result.current.canPreviousPage).toBe(true);
    expect(result.current.canNextPage).toBe(false);
  });

  // Changing page size should not fling the reader back to the top of the list.
  it('keeps the reader near their place when the page size changes', () => {
    const { result } = renderHook(() => usePagination(rows(200), 25));

    act(() => result.current.setPageIndex(4)); // rows 101-125
    act(() => result.current.setPageSize(50));

    // Row 100 now lives on page 3 (rows 101-150), so that is where they land.
    expect(result.current.pageIndex).toBe(2);
    expect(result.current.pageItems[0]).toBe(100);
  });

  // A sync can shrink the list while someone is on a later page, which would otherwise strand them on an
  // empty page with no rows and no obvious way back.
  it('clamps onto the last page when the list shrinks underneath it', () => {
    const { result, rerender } = renderHook(({ items }) => usePagination(items, 25), {
      initialProps: { items: rows(200) },
    });

    act(() => result.current.setPageIndex(7));
    expect(result.current.pageIndex).toBe(7);

    rerender({ items: rows(30) });

    expect(result.current.pageIndex).toBe(1);
    expect(result.current.pageItems.length).toBeGreaterThan(0);
  });

  it('always reports at least one page, even with nothing to show', () => {
    const { result } = renderHook(() => usePagination(rows(0), 25));

    expect(result.current.pageCount).toBe(1);
    expect(result.current.pageItems).toEqual([]);
    expect([result.current.firstRowOnPage, result.current.lastRowOnPage]).toEqual([0, 0]);
  });

  // Short tables hide the controls entirely rather than showing a permanently disabled "Page 1 of 1".
  it('only counts as paginated once it exceeds the threshold', () => {
    const { result: atThreshold } = renderHook(() => usePagination(rows(PAGINATION_ROW_THRESHOLD), 25));
    const { result: aboveThreshold } = renderHook(() => usePagination(rows(PAGINATION_ROW_THRESHOLD + 1), 25));

    expect(atThreshold.current.isPaginated).toBe(false);
    expect(aboveThreshold.current.isPaginated).toBe(true);
  });
});
