'use client';

import { cn } from 'lib/utils/classnames';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

const Toggle = ({ checked, onChange, label, description, disabled }: Props) => (
  <div className="flex items-start justify-between gap-4 py-2">
    <div className="min-w-0">
      <div className="text-sm font-medium">{label}</div>
      {description ? <div className="text-xs text-zinc-500 mt-0.5">{description}</div> : null}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        // Deliberately borderless: a border would sit inside the 36px box and shift the thumb's positioning
        // origin, leaving the travel visibly off-centre by a pixel at each end.
        'relative shrink-0 w-9 h-5 rounded-full transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        checked ? 'bg-black dark:bg-white' : 'bg-zinc-200 dark:bg-zinc-800',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          // `left-0` is load-bearing: without a horizontal anchor an absolutely positioned element falls
          // back to its static position, which put the thumb at the right of the track and let the checked
          // state translate it clean outside the track.
          'absolute left-0 top-0.5 size-4 rounded-full transition-transform duration-150',
          // 2px of inset on each side: the track is 36px and the thumb 16px, so 18px is the travelled edge.
          checked ? 'translate-x-[18px] bg-white dark:bg-black' : 'translate-x-0.5 bg-white dark:bg-zinc-500',
        )}
      />
    </button>
  </div>
);

export default Toggle;
