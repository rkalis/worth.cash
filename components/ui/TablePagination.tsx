'use client';

import Button from 'components/ui/Button';
import { PAGE_SIZE_OPTIONS, type Pagination } from 'lib/hooks/usePagination';
import { cn } from 'lib/utils/classnames';

interface Props<T> {
  pagination: Pagination<T>;
  className?: string;
}

const ChevronLeft = () => (
  <svg viewBox="0 0 20 20" fill="none" className="size-4" role="presentation">
    <path
      d="M12.5 15 7.5 10l5-5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ChevronRight = () => (
  <svg viewBox="0 0 20 20" fill="none" className="size-4" role="presentation">
    <path d="m7.5 5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Mirrors the revoke.cash table footer: a range readout, a page size selector, and first/previous/next/last.
// It hides itself entirely for short tables, where the controls would be more chrome than help.
const TablePagination = <T,>({ pagination, className }: Props<T>) => {
  if (!pagination.isPaginated) return null;

  const { pageIndex, pageCount, pageSize, totalRows, firstRowOnPage, lastRowOnPage } = pagination;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800',
        className,
      )}
    >
      <span className="text-xs text-zinc-600 dark:text-zinc-400 tabular">
        Showing {firstRowOnPage} to {lastRowOnPage} of {totalRows}
      </span>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          Show
          <select
            aria-label="Rows per page"
            value={pageSize}
            onChange={(event) => pagination.setPageSize(Number(event.target.value))}
            className="h-7 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-1.5 text-xs"
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <Button
            variant="tertiary"
            size="sm"
            aria-label="First page"
            disabled={!pagination.canPreviousPage}
            onClick={() => pagination.setPageIndex(0)}
          >
            First
          </Button>

          <Button
            variant="tertiary"
            size="sm"
            aria-label="Previous page"
            disabled={!pagination.canPreviousPage}
            onClick={() => pagination.setPageIndex(pageIndex - 1)}
          >
            <ChevronLeft />
          </Button>

          <span className="px-2 text-xs text-zinc-600 dark:text-zinc-400 tabular whitespace-nowrap">
            Page {pageIndex + 1} of {pageCount}
          </span>

          <Button
            variant="tertiary"
            size="sm"
            aria-label="Next page"
            disabled={!pagination.canNextPage}
            onClick={() => pagination.setPageIndex(pageIndex + 1)}
          >
            <ChevronRight />
          </Button>

          <Button
            variant="tertiary"
            size="sm"
            aria-label="Last page"
            disabled={!pagination.canNextPage}
            onClick={() => pagination.setPageIndex(pageCount - 1)}
          >
            Last
          </Button>
        </div>
      </div>
    </div>
  );
};

export default TablePagination;
