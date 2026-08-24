'use client';

import ChainLogo from 'components/ui/ChainLogo';
import ExchangeLogo from 'components/ui/ExchangeLogo';
import { useLocationIcon } from 'lib/hooks/useLocationIcon';

interface Props {
  location: string;
  size?: number;
}

// A manual holding's location, drawn as whatever the app can work out it is.
//
// The dashed circle is the honest fallback rather than the default: it says "somewhere you told us about"
// for a place with no icon to find, like a wallet brand or "cold storage".
const ManualLocationLogo = ({ location, size = 14 }: Props) => {
  const resolveIcon = useLocationIcon();
  const icon = resolveIcon(location);

  if (icon.chainId !== undefined) return <ChainLogo chainId={icon.chainId} size={size} />;
  if (icon.exchange) return <ExchangeLogo exchange={icon.exchange} size={size} />;

  if (icon.logoUrl) {
    return (
      <img
        src={icon.logoUrl}
        alt={location}
        title={location}
        width={size}
        height={size}
        loading="lazy"
        className="rounded-full shrink-0 object-cover bg-white"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      title="Added by hand"
      aria-hidden="true"
      className="shrink-0 rounded-full border border-dashed border-zinc-400 dark:border-zinc-600"
      style={{ width: size, height: size }}
    />
  );
};

export default ManualLocationLogo;
