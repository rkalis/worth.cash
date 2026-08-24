'use client';

import ChainLogo from 'components/ui/ChainLogo';
import ExchangeLogo from 'components/ui/ExchangeLogo';
import { useCurrency } from 'lib/hooks/useCurrency';
import type { PortfolioTotals } from 'lib/portfolio/aggregate';
import type { BreakdownEntry } from 'lib/portfolio/breakdown';
import { cn } from 'lib/utils/classnames';

interface Props {
  totals: PortfolioTotals;
  tokenChainBreakdown: BreakdownEntry[];
  nftChainBreakdown: BreakdownEntry[];
  exchangeBreakdown: BreakdownEntry[];
}

// Where the money sits, split by kind of holding. The headline figure and the chart behind it live in
// PortfolioValue; this is the layer underneath that says what makes it up.
const PortfolioSummary = ({ totals, tokenChainBreakdown, nftChainBreakdown, exchangeBreakdown }: Props) => {
  return (
    <div className="grid gap-3 md:grid-cols-3 items-start">
      <SummaryTile label="Tokens" value={totals.tokensUsd} total={totals.totalUsd} breakdown={tokenChainBreakdown} />
      <SummaryTile label="NFTs" value={totals.nftsUsd} total={totals.totalUsd} breakdown={nftChainBreakdown} />
      <SummaryTile
        label="Exchanges"
        value={totals.exchangesUsd}
        total={totals.totalUsd}
        breakdown={exchangeBreakdown}
      />
    </div>
  );
};

interface TileProps {
  label: string;
  value: number;
  total: number;
  breakdown: BreakdownEntry[];
}

const SummaryTile = ({ label, value, total, breakdown }: TileProps) => {
  const { formatValue } = useCurrency();

  const share = total > 0 ? (value / total) * 100 : 0;

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-xs text-zinc-500">{label}</span>
        <span className="text-[11px] text-zinc-400 tabular">{share.toFixed(0)}%</span>
      </div>
      <div className="text-lg font-semibold tabular">{formatValue(value)}</div>
      <div className="mt-2 h-1 rounded-full bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
        <div className={cn('h-full rounded-full bg-zinc-400 dark:bg-zinc-600')} style={{ width: `${share}%` }} />
      </div>

      {breakdown.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5 border-t border-zinc-100 dark:border-zinc-900 pt-2.5">
          {breakdown.map((entry) => (
            <li key={entry.key} className="flex items-center gap-2 text-xs">
              {entry.chainId !== undefined ? <ChainLogo chainId={entry.chainId} size={14} /> : null}
              {entry.exchange !== undefined ? <ExchangeLogo exchange={entry.exchange} size={14} /> : null}
              {entry.chainId === undefined && entry.exchange === undefined ? (
                <span className="size-3.5 shrink-0" />
              ) : null}
              <span
                className={cn('truncate', entry.isRemainder ? 'text-zinc-400' : 'text-zinc-600 dark:text-zinc-400')}
              >
                {entry.label}
              </span>
              <span
                className={cn(
                  'ml-auto tabular shrink-0',
                  entry.isRemainder ? 'text-zinc-400' : 'text-zinc-700 dark:text-zinc-300',
                )}
              >
                {formatValue(entry.valueUsd)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

export default PortfolioSummary;
