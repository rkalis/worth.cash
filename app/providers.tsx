'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { loadSettings } from 'lib/db/settings';
import { CurrencyProvider } from 'lib/hooks/useCurrency';
import { type ReactNode, useEffect, useState } from 'react';

// Hydrates the runtime settings snapshot before anything tries to read an API key from it, and holds the
// first render back until it has. Without this, a sync kicked off on load would run with default settings
// and therefore without the user's keys.
const SettingsHydrator = ({ children }: { children: ReactNode }) => {
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    loadSettings()
      .catch(() => undefined)
      .finally(() => setIsHydrated(true));
  }, []);

  if (!isHydrated) return null;

  return <>{children}</>;
};

const Providers = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The portfolio's source of truth is IndexedDB, which pushes updates through live queries, so
            // refetching on window focus would only duplicate work.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SettingsHydrator>
        <CurrencyProvider>{children}</CurrencyProvider>
      </SettingsHydrator>
    </QueryClientProvider>
  );
};

export default Providers;
