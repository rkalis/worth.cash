import { getChainLogo, getChainName } from 'lib/chains';
import { cn } from 'lib/utils/classnames';

interface Props {
  chainId: number;
  size?: number;
  className?: string;
}

const ChainLogo = ({ chainId, size = 16, className }: Props) => {
  const logoUrl = getChainLogo(chainId as never);
  const name = getChainName(chainId as never);

  if (!logoUrl) {
    return (
      <span
        title={name}
        className={cn('inline-block rounded-full bg-zinc-200 dark:bg-zinc-800 shrink-0', className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    // Chain logos are local static assets, so a plain img avoids the loader indirection entirely.
    <img
      src={logoUrl}
      alt={name}
      title={name}
      width={size}
      height={size}
      className={cn('rounded-full shrink-0 object-cover bg-white', className)}
      style={{ width: size, height: size }}
    />
  );
};

export default ChainLogo;
