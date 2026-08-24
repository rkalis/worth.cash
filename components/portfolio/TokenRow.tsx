'use client';

import ManualLocationLogo from 'components/manual/ManualLocationLogo';
import CategorySelect from 'components/portfolio/CategorySelect';
import Badge from 'components/ui/Badge';
import ChainLogo from 'components/ui/ChainLogo';
import ExchangeLogo from 'components/ui/ExchangeLogo';
import TokenLogo from 'components/ui/TokenLogo';
import { formatAmount, formatShare, shortenAddress } from 'lib/format';
import { useCurrency } from 'lib/hooks/useCurrency';
import { useTokenOverrides } from 'lib/hooks/useTokenOverrides';
import type { AggregatedToken, TokenContractHolding, TokenLocation } from 'lib/portfolio/aggregate';
import { cn } from 'lib/utils/classnames';
import { useState } from 'react';

interface Props {
  token: AggregatedToken;
  totalValueUsd: number;
  // Decided by the table rather than here, so that the header and every row agree on the column count.
  showCategory?: boolean;
}

const TokenRow = ({ token, totalValueUsd, showCategory }: Props) => {
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

        <td className="py-2.5 px-2 text-right text-sm font-medium tabular">{formatValue(token.valueUsd)}</td>

        <td className="py-2.5 px-2 text-right text-sm tabular text-zinc-500 dark:text-zinc-400">
          {formatShare(share)}
        </td>

        {showCategory ? (
          <td className="py-2.5 px-2 hidden md:table-cell">
            <CategorySelect
              assetKeys={[token.overrideKey, ...token.supersededOverrideKeys]}
              categoryId={token.categoryId}
              label={token.symbol}
            />
          </td>
        ) : null}

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
                  ) : location.kind === 'exchange' ? (
                    <ExchangeLogo exchange={location.exchange} size={14} />
                  ) : (
                    <ManualLocationLogo location={location.name} size={14} />
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
              {showCategory ? <td className="hidden md:table-cell" /> : null}
              <td />
              <td />
            </tr>
          ))
        : null}
    </>
  );
};

const describeLocations = (locations: TokenLocation[]): string => {
  const kinds = new Set(locations.map((location) => location.kind));

  // Named for what the row actually spans, and only when every location agrees. "3 chains" was true when a
  // chain was the only kind of place an asset could be; calling an exchange account or a hand-entered
  // holding a chain would just be wrong.
  if (kinds.size === 1) {
    const [kind] = [...kinds];
    if (kind === 'chain') return `${locations.length} chains`;
    if (kind === 'exchange') return `${locations.length} exchanges`;
  }

  return `${locations.length} locations`;
};

// Contracts are identified by address rather than by name, since a name is exactly the thing an impostor
// controls and the rest of the row deliberately shows none.
const describeContracts = (contracts: TokenContractHolding[]): string =>
  contracts.map((contract) => shortenAddress(contract.token)).join(', ');

export default TokenRow;
