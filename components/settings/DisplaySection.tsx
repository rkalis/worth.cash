'use client';

import Card from 'components/ui/Card';
import { CURRENCY_LABELS, DISPLAY_CURRENCIES, type DisplayCurrency } from 'lib/fiat/rates';
import { useCurrency } from 'lib/hooks/useCurrency';
import { useSettings } from 'lib/hooks/useSettings';

const DisplaySection = () => {
  const { settings, updateSettings } = useSettings();
  const { isRateAvailable, isRateLoading, ratesDate, requestedCurrency } = useCurrency();

  return (
    <Card title="Display" bodyClassName="flex flex-col gap-2">
      <p className="text-xs text-zinc-500">
        Every price is fetched and stored in US dollars. Another currency is converted from that at display time, using
        the European Central Bank's daily reference rate, so nothing about your stored data changes when you switch.
      </p>

      <div className="max-w-64">
        <label htmlFor="display-currency" className="block text-xs text-zinc-500 mb-1">
          Currency
        </label>
        <select
          id="display-currency"
          value={settings.display.currency}
          onChange={(event) =>
            updateSettings({ display: { ...settings.display, currency: event.target.value as DisplayCurrency } })
          }
          className="h-8 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 text-sm"
        >
          {DISPLAY_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {CURRENCY_LABELS[currency]}
            </option>
          ))}
        </select>
      </div>

      {/* Said out loud rather than silently falling back, because the numbers on screen would be dollars
          while the setting claims otherwise. */}
      {requestedCurrency !== 'usd' && !isRateAvailable && !isRateLoading ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          The exchange rate could not be fetched, so values are shown in US dollars for now.
        </p>
      ) : null}

      {requestedCurrency !== 'usd' && isRateAvailable && ratesDate ? (
        <p className="text-xs text-zinc-500">Using the reference rate published on {ratesDate}.</p>
      ) : null}
    </Card>
  );
};

export default DisplaySection;
