'use client';

import Button from 'components/ui/Button';
import Card from 'components/ui/Card';
import { useLiveQuery } from 'dexie-react-hooks';
import { clearSyncedData, db } from 'lib/db';
import { useState } from 'react';

const DataSection = () => {
  const [isClearing, setIsClearing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  const counts = useLiveQuery(
    async () => ({
      events: await db.transferEvents.count(),
      balances: await db.balances.count(),
      nfts: await db.nftItems.count(),
      snapshots: await db.snapshots.count(),
    }),
    [],
  );

  const clear = async () => {
    setIsClearing(true);
    try {
      await clearSyncedData();
      setIsConfirming(false);
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Card title="Local data" bodyClassName="flex flex-col gap-3">
      <p className="text-xs text-zinc-500">
        Everything lives in this browser's IndexedDB. Nothing is sent anywhere except to the APIs whose keys you
        configured, and clearing your browser data removes all of it.
      </p>

      {counts ? (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <Stat label="Transfer events" value={counts.events} />
          <Stat label="Balances" value={counts.balances} />
          <Stat label="NFTs" value={counts.nfts} />
          <Stat label="Snapshots" value={counts.snapshots} />
        </dl>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        {isConfirming ? (
          <>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              This deletes all synced data and forces a full resync. Your wallets, keys and settings are kept.
            </span>
            <Button variant="danger" size="sm" onClick={clear} loading={isClearing}>
              Confirm
            </Button>
            <Button variant="tertiary" size="sm" onClick={() => setIsConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setIsConfirming(true)}>
            Clear synced data
          </Button>
        )}
      </div>
    </Card>
  );
};

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg py-2">
    <dt className="text-[11px] text-zinc-500">{label}</dt>
    <dd className="text-base font-semibold tabular">{value.toLocaleString('en-US')}</dd>
  </div>
);

export default DataSection;
