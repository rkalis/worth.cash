import { cn } from 'lib/utils/classnames';
import type { ReactNode } from 'react';

interface Props {
  variant?: 'neutral' | 'warning' | 'danger' | 'success' | 'brand';
  className?: string;
  children: ReactNode;
}

const VARIANT_CLASSES = {
  neutral: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400',
  danger: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400',
  success: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400',
  brand: 'bg-brand/20 text-amber-800 dark:text-brand',
} as const;

const Badge = ({ variant = 'neutral', className, children }: Props) => (
  <span
    className={cn(
      'inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium leading-none whitespace-nowrap',
      VARIANT_CLASSES[variant],
      className,
    )}
  >
    {children}
  </span>
);

export default Badge;
