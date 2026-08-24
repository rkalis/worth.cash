import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Merges conditional class names while letting later Tailwind utilities win over earlier ones, so a caller
// can override a component's defaults by passing a competing class.
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
