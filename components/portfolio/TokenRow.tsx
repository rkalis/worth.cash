'use client';

import Badge from 'components/ui/Badge';
import ChainLogo from 'components/ui/ChainLogo';
import ExchangeLogo from 'components/ui/ExchangeLogo';
import TokenLogo from 'components/ui/TokenLogo';
import { formatAmount, shortenAddress } from 'lib/format';
import { useCurrency } from 'lib/hooks/useCurrency';
import { useTokenOverrides } from 'lib/hooks/useTokenOverrides';
import type { AggregatedToken, TokenContractHolding, TokenLocation } from 'lib/portfolio/aggregate';
import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

interface Props {
  token: AggregatedToken;
  totalValueUsd: number;
}

const TokenRow = ({ token, totalValueUsd }: Props) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { setPositionHidden } = useTokenOverrides();
  const { formatValue, formatPrice } = useCurrency();

  const isSplit = token.locations.length > 1;
  const share = totalValueUsd > 0 && token.valueUsd ? (token.valueUsd / totalValueUsd) * 100 : 0;

  return (
    <>
      <tr
        className={cn(
          'border-b border-zinc-100 dark:border-zinc-900 transition-colors',
          isSplit && 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-950',
        )}
        onClick={() => isSplit && setIsExpanded(!isExpanded)}
      >
        <td className="py-2.5 pl-4 pr-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <TokenLogo src={token.logoUrl} symbol={token.symbol} size={20} />

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-sm truncate">{token.symbol}</span>
                {isSplit ? <Badge>{describeLocations(token.locations)}</Badge> : null}
                {token.isSpam ? <Badge variant="warning">spam</Badge> : null}
              </div>
            </div>
          </div>
        </td>

        <td className="py-2.5 px-2 text-right text-sm tabular text-zinc-600 dark:text-zinc-400 hidden sm:table-cell">
          {formatPrice(token.priceUsd)}
        </td>

        <td className="py-2.5 px-2 text-right text-sm tabular">{formatAmount(token.totalAmount)}</td>

        <td className="py-2.5 px-2 text-right">
          <div className="text-sm font-medium tabular">{formatValue(token.valueUsd)}</div>
          {share >= 0.1 ? <div className="text-[11px] text-zinc-400 tabular">{share.toFixed(1)}%</div> : null}
        </td>

        <td className="py-2.5 pr-4 pl-2 text-right w-8">
          <button
            type="button"
            aria-label={token.isHidden ? `Show ${token.symbol}` : `Hide ${token.symbol}`}
            title={token.isHidden ? 'Show this token' : 'Hide this token'}
            className="text-xs text-zinc-400 hover:text-black dark:hover:text-white px-1"
            onClick={(event) => {
              event.stopPropagation();
              setPositionHidden(token, !token.isHidden);
            }}
          >
            {token.isHidden ? 'show' : 'hide'}
          </button>
        </td>
      </tr>

      {isExpanded
        ? token.locations.map((location) => (
            <tr
              key={`${token.key}:${location.key}`}
              className="border-b border-zinc-100 dark:border-zinc-900 bg-zinc-50/60 dark:bg-zinc-950/60"
            >
              <td className="py-1.5 pl-4 pr-2">
                <div className="flex items-center gap-2 pl-8 min-w-0">
                  {location.kind === 'chain' ? (
                    <ChainLogo chainId={location.chainId} size={14} />
                  ) : (
                    <ExchangeLogo exchange={location.exchange} size={14} />
                  )}
                  <span className="text-xs text-zinc-600 dark:text-zinc-400 shrink-0">{location.name}</span>
                  {/* A chain can hold the same asset under more than one contract, native and bridged USDC
                      being the usual case. Naming them is what stops the combined figure looking arbitrary. */}
                  {location.kind === 'chain' && location.contracts.length > 1 ? (
                    <span className="text-[11px] text-zinc-400 truncate" title={describeContracts(location.contracts)}>
                      {location.contracts.length} tokens · {describeContracts(location.contracts)}
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="hidden sm:table-cell" />
              <td className="py-1.5 px-2 text-right text-xs tabular text-zinc-600 dark:text-zinc-400">
                {formatAmount(location.amount)}
              </td>
              <td className="py-1.5 px-2 text-right text-xs tabular text-zinc-600 dark:text-zinc-400">
                {formatValue(location.valueUsd)}
              </td>
              <td />
            </tr>
          ))
        : null}
    </>
  );
};

// Named for what the row actually spans. "3 chains" was true when a chain was the only kind of place an
// asset could be, and calling an exchange account a chain now would just be wrong.
const describeLocations = (locations: TokenLocation[]): string => {
  const chainCount = locations.filter((location) => location.kind === 'chain').length;

  if (chainCount === locations.length) return `${chainCount} chains`;
  if (chainCount === 0) return `${locations.length} exchanges`;
  return `${locations.length} locations`;
};

// Contracts are identified by address rather than by name, since a name is exactly the thing an impostor
// controls and the rest of the row deliberately shows none.
const describeContracts = (contracts: TokenContractHolding[]): string =>
  contracts.map((contract) => shortenAddress(contract.token)).join(', ');

export default TokenRow;
