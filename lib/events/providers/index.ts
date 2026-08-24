import { DivideAndConquerLogsProvider, type DivideAndConquerOptions } from './DivideAndConquerLogsProvider';
import { EventGetterLogsProvider } from './EventGetterLogsProvider';
import type { LogsProvider } from './LogsProvider';
import { ViemLogsProvider } from './ViemLogsProvider';

export { DivideAndConquerLogsProvider } from './DivideAndConquerLogsProvider';
export { EventGetterLogsProvider } from './EventGetterLogsProvider';
export type { LogsProvider } from './LogsProvider';
export { ViemLogsProvider } from './ViemLogsProvider';

// The provider used for syncing: whichever source the chain is configured for, with automatic block-range
// bisection layered on top so that no caller has to know a given provider's range or result limits.
export const getLogsProvider = (chainId: number): LogsProvider => {
  return new DivideAndConquerLogsProvider(new EventGetterLogsProvider(chainId));
};

export const getRpcLogsProvider = (
  chainId: number,
  divideAndConquerOptions?: DivideAndConquerOptions,
): LogsProvider => {
  // No explicit URL, so the provider uses the chain's full endpoint list and can fail over.
  return new DivideAndConquerLogsProvider(new ViemLogsProvider(chainId), divideAndConquerOptions);
};
