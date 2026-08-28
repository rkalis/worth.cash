'use client';

import type { ReactElement, ReactNode } from 'react';
import Tooltip from './Tooltip';

interface Props {
  tooltip: ReactNode;
  children: ReactElement;
}

// Ported from revoke.cash. Wraps any element so hovering or focusing it shows the tooltip.
const WithHoverTooltip = ({ tooltip, children }: Props) => {
  const contentClasses = [
    'max-w-[400px] break-words font-normal text-xs text-left border py-1.5 px-2.5 rounded-md z-50',
    'border-zinc-800 text-zinc-800 bg-zinc-100',
    'dark:border-zinc-100 dark:text-zinc-200 dark:bg-zinc-800',
  ].join(' ');

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Content className={contentClasses}>
        {tooltip}
        <Tooltip.Arrow className="fill-zinc-100 dark:fill-zinc-800 stroke-zinc-800 dark:stroke-zinc-100" />
      </Tooltip.Content>
    </Tooltip.Root>
  );
};

export default WithHoverTooltip;
