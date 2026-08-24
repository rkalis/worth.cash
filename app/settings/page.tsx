'use client';

import ApiKeysSection from 'components/settings/ApiKeysSection';
import ChainsSection from 'components/settings/ChainsSection';
import DataSection from 'components/settings/DataSection';
import DisplaySection from 'components/settings/DisplaySection';
import ExchangesSection from 'components/settings/ExchangesSection';
import FiltersSection from 'components/settings/FiltersSection';
import RpcSection from 'components/settings/RpcSection';
import WalletsSection from 'components/settings/WalletsSection';

const SettingsPage = () => (
  <div className="flex flex-col gap-6">
    <div>
      <h1>Settings</h1>
      <p className="text-sm text-zinc-500 mt-1">
        Everything here is stored in this browser only. Nothing is uploaded, and there is no account.
      </p>
    </div>

    <WalletsSection />
    <ApiKeysSection />
    <ExchangesSection />
    <ChainsSection />
    <RpcSection />
    <DisplaySection />
    <FiltersSection />
    <DataSection />
  </div>
);

export default SettingsPage;
