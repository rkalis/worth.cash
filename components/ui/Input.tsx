'use client';

import InfoTooltip from 'components/ui/InfoTooltip';
import { cn } from 'lib/utils/classnames';
import type { InputHTMLAttributes, ReactNode } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  // Detail worth having but not worth a hint line under the field.
  tooltip?: ReactNode;
  error?: string;
  monospace?: boolean;
}

const Input = ({ label, hint, tooltip, error, monospace, className, id, ...props }: Props) => {
  const inputId = id ?? props.name;

  return (
    <label className="block" htmlFor={inputId}>
      {label ? (
        <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
          {label}
          {tooltip ? <InfoTooltip tooltip={tooltip} /> : null}
        </span>
      ) : null}
      <input
        id={inputId}
        className={cn(
          'w-full h-9 px-3 rounded-lg border bg-white dark:bg-zinc-950 text-sm',
          'border-zinc-300 dark:border-zinc-700 placeholder:text-zinc-400',
          'focus:outline-2 focus:outline-offset-0 focus:outline-brand',
          monospace && 'font-mono text-xs',
          error && 'border-red-400 dark:border-red-800',
          className,
        )}
        {...props}
      />
      {error ? <span className="block text-xs text-red-600 dark:text-red-400 mt-1">{error}</span> : null}
      {hint && !error ? <span className="block text-xs text-zinc-500 mt-1">{hint}</span> : null}
    </label>
  );
};

export default Input;
