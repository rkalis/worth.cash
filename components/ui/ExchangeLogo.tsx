import type { ExchangeKind } from 'lib/db/schema';
import { cn } from 'lib/utils/classnames';

interface Props {
  exchange: ExchangeKind;
  size?: number;
  className?: string;
}

const EXCHANGE_LOGO_URLS: Record<ExchangeKind, string> = {
  coinbase: '/assets/images/vendor/exchanges/coinbase.svg',
  kraken: '/assets/images/vendor/exchanges/kraken.svg',
};

const EXCHANGE_NAMES: Record<ExchangeKind, string> = {
  coinbase: 'Coinbase',
  kraken: 'Kraken',
};

// An exchange's brand mark, sized to sit in the same slot as a chain logo.
//
// Local static assets rather than remote ones, for the same reason the chain logos are: the app has to work
// with no network and no third party gets to see which exchanges are being tracked.
//
// Each is the brand's own mark, redrawn from primitives so it stays exact at 14px: Coinbase's ring and dot,
// Kraken's tentacles on a disc in their purple.
const ExchangeLogo = ({ exchange, size = 16, className }: Props) => {
  const name = EXCHANGE_NAMES[exchange];

  return (
    <img
      src={EXCHANGE_LOGO_URLS[exchange]}
      alt={name}
      title={name}
      width={size}
      height={size}
      className={cn('rounded-full shrink-0 object-contain', className)}
      style={{ width: size, height: size }}
    />
  );
};

export default ExchangeLogo;
