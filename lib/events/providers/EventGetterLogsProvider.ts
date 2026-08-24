import type { Filter, Log } from 'lib/events';
import { type EventGetter, getEventGetter } from 'lib/events/getters';
import { withTimeout } from 'lib/utils/promises';
import { SECOND } from 'lib/utils/time';
import type { LogsProvider } from './LogsProvider';

// Adapts an EventGetter, which is chosen per chain by support type, to the LogsProvider interface, so that
// it can be wrapped in DivideAndConquerLogsProvider like any other source.
export class EventGetterLogsProvider implements LogsProvider {
  private eventGetter: EventGetter;

  constructor(public chainId: number) {
    this.eventGetter = getEventGetter(chainId);
  }

  async getLatestBlock(): Promise<number> {
    return withTimeout(this.eventGetter.getLatestBlock(this.chainId), 30 * SECOND, 'Latest block request timed out');
  }

  async getLogs(filter: Filter): Promise<Log[]> {
    // A wide range against a fast source can legitimately take a while, and a timeout here is indistinguishable
    // from a response-size problem to the caller, which then narrows the range and retries.
    return withTimeout(this.eventGetter.getEvents(this.chainId, filter), 60 * SECOND, 'Event getter timed out');
  }
}
