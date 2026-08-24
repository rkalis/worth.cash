'use client';

import { cn } from 'lib/utils/classnames';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import Spinner from './Spinner';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASSES = {
  primary:
    'bg-black text-white hover:bg-zinc-800 disabled:bg-zinc-600 dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700',
  secondary:
    'bg-white text-black hover:bg-zinc-100 disabled:text-zinc-400 dark:bg-black dark:text-white dark:hover:bg-zinc-900',
  tertiary: 'border-transparent text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-white',
  danger: 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950',
} as const;

const SIZE_CLASSES = {
  sm: 'h-7 px-2.5 text-xs rounded-md gap-1.5',
  md: 'h-9 px-4 text-sm rounded-lg gap-2',
  lg: 'h-11 px-6 text-base rounded-lg gap-2',
} as const;

const Button = ({ variant = 'secondary', size = 'md', loading, disabled, className, children, ...props }: Props) => {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center border border-zinc-300 dark:border-zinc-700 font-medium leading-none',
        'whitespace-nowrap shrink-0 transition-colors duration-150 disabled:cursor-not-allowed',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
};

export default Button;
