'use client';

import CollectionCard from 'components/nfts/CollectionCard';
import Card from 'components/ui/Card';
import EmptyState from 'components/ui/EmptyState';
import Spinner from 'components/ui/Spinner';
import { useCurrency } from 'lib/hooks/useCurrency';
import { usePortfolio } from 'lib/hooks/usePortfolio';
import { useSettings } from 'lib/hooks/useSettings';
import Link from 'next/link';

const NftsPage = () => {
  const portfolio = usePortfolio();
  const { formatValue } = useCurrency();
  const { settings } = useSettings();

  if (portfolio.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-zinc-500">
        <Spinner className="size-5" />
      </div>
    );
  }

  const collectionsWithoutFloor = portfolio.nftCollections.filter((collection) => collection.floorPriceUsd === null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1>NFTs</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {portfolio.nftCollections.length} collection{portfolio.nftCollections.length === 1 ? '' : 's'} ·{' '}
          {formatValue(portfolio.totals.nftsUsd)} at floor
        </p>
      </div>

      {collectionsWithoutFloor.length > 0 ? (
        <Card>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {collectionsWithoutFloor.length} collection{collectionsWithoutFloor.length === 1 ? ' has' : 's have'} no
            floor price. Floors come from CoinGecko first, which indexes around two thousand collections, and then from
            OpenSea, which covers far more but only on the chains it runs a marketplace on.
            {!settings.apiKeys.opensea ? (
              <>
                {' '}
                <Link href="/settings" className="underline">
                  Adding an OpenSea API key
                </Link>{' '}
                would cover most of the remainder.
              </>
            ) : null}
          </p>
        </Card>
      ) : null}

      {portfolio.nftCollections.length === 0 ? (
        <Card>
          <EmptyState
            title="No NFTs found"
            description="Run a sync from the portfolio page. NFTs are discovered from transfer events, so a wallet that has never received one will show nothing here."
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {portfolio.nftCollections.map((collection) => (
            <CollectionCard key={collection.key} collection={collection} />
          ))}
        </div>
      )}
    </div>
  );
};

export default NftsPage;
