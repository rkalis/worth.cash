'use client';

import WithHoverTooltip from 'components/ui/WithHoverTooltip';
import type { ReactNode } from 'react';

interface Props {
  tooltip: ReactNode;
}

// The small circled i that carries detail out of the way, following revoke.cash's InformationIconTooltip.
// The icon is heroicons' information-circle outline, inlined rather than pulling in the icon package for
// one glyph.
const InfoTooltip = ({ tooltip }: Props) => (
  <WithHoverTooltip tooltip={tooltip}>
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-label="More information"
      role="img"
      tabIndex={0}
      className="w-3.5 h-3.5 shrink-0 text-zinc-500 cursor-help focus:outline-none focus-visible:outline-2 focus-visible:outline-brand rounded-full"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"
      />
    </svg>
  </WithHoverTooltip>
);

export default InfoTooltip;
