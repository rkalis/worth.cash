import type { Log, LogPosition } from 'lib/events';
import { deduplicateArray } from 'lib/utils';
import { type Address, getAddress, type Hex, pad, slice } from 'viem';

export const topicToAddress = (topic: Hex) => getAddress(slice(topic, 12));
export const addressToTopic = (address: Address) => pad(address, { size: 32 }).toLowerCase() as Hex;

export const logSorterChronological = (a: LogPosition, b: LogPosition) => {
  if (a.blockNumber === b.blockNumber) {
    if (a.transactionIndex === b.transactionIndex) {
      return a.logIndex - b.logIndex;
    }
    return a.transactionIndex - b.transactionIndex;
  }
  return a.blockNumber - b.blockNumber;
};

export const sortLogsChronologically = (logs: Log[]) => logs.sort(logSorterChronological);

// The same log can be returned by more than one of our filters (for example a self-transfer matches both
// the inbound and the outbound filter), so we deduplicate on its unique on-chain position.
export const deduplicateLogs = (logs: Log[]): Log[] => {
  return deduplicateArray(logs, (log) => `${log.transactionHash}-${log.logIndex}`);
};
