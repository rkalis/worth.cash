import type { Address } from 'viem';

export const assertFulfilled = <T>(item: PromiseSettledResult<T>): item is PromiseFulfilledResult<T> => {
  return item.status === 'fulfilled';
};

export const toLowercaseAddress = (address: Address): Address => address.toLowerCase() as Address;

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const timeout = (ms: number, message: string): Promise<never> => {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms));
};

export const isNullish = (value: unknown): value is null | undefined => {
  return value === null || value === undefined;
};

// O(n) rather than O(n^2), which matters because we deduplicate very large log arrays during a full sync.
export const deduplicateArray = <T>(
  array: readonly T[],
  keyGenerator: (item: T) => string = (item) => `${item}`,
): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of array) {
    const key = keyGenerator(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
};

export const range = (length: number) => Array.from({ length }, (_, i) => i);

export const isBrowser = (): boolean => typeof globalThis === 'object' && 'window' in globalThis;

export const chunkArray = <T>(array: readonly T[], chunkSize: number): T[][] => {
  const result: T[][] = [];

  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize));
  }

  return result;
};

export const slugify = (text: string) => {
  return text.toLowerCase().replace(/ /g, '_');
};

export const singleton = <T>(factory: () => T): (() => T) => {
  let instance: T | undefined;

  return () => {
    if (!instance) instance = factory();
    return instance;
  };
};

// Groups array entries by a derived key, preserving insertion order within each group.
export const groupBy = <T>(array: readonly T[], keyGenerator: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();

  for (const item of array) {
    const key = keyGenerator(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return groups;
};

export const sumBy = <T>(array: readonly T[], selector: (item: T) => number): number => {
  return array.reduce((total, item) => total + selector(item), 0);
};
