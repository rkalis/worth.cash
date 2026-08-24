'use client';

import EmptyState from 'components/ui/EmptyState';
import TablePagination from 'components/ui/TablePagination';
import { usePagination } from 'lib/hooks/usePagination';
import type { AggregatedToken } from 'lib/portfolio/aggregate';
import TokenRow from './TokenRow';

interface Props {
  tokens: AggregatedToken[];
  totalValueUsd: number;
  emptyTitle?: string;
  emptyDescription?: string;
}

const TokenTable = ({ tokens, totalValueUsd, emptyTitle, emptyDescription }: Props) => {
  // Called before the early return, since hooks cannot be skipped on the empty path.
  const pagination = usePagination(tokens);

  if (tokens.length === 0) {
    return <EmptyState title={emptyTitle ?? 'No assets yet'} description={emptyDescription} />;
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[580px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
              <th className="text-left font-medium py-2 pl-4 pr-2">Asset</th>
              <th className="text-right font-medium py-2 px-2 hidden sm:table-cell">Price</th>
              <th className="text-right font-medium py-2 px-2">Amount</th>
              <th className="text-right font-medium py-2 px-2">Value</th>
              <th className="text-right font-medium py-2 px-2">Share</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {pagination.pageItems.map((token) => (
              <TokenRow key={token.key} token={token} totalValueUsd={totalValueUsd} />
            ))}
          </tbody>
        </table>
      </div>

      <TablePagination pagination={pagination} />
    </>
  );
};

export default TokenTable;
