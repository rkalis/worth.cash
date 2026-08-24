import { EtherscanEventGetter } from './EtherscanEventGetter';
import type { EventGetter } from './EventGetter';

// Routescan is fully Etherscan compatible. It exists as its own class only so that the support type maps to
// something, and so its per-instance rate limiting stays separate from Etherscan's.
export class RoutescanEventGetter extends EtherscanEventGetter implements EventGetter {}
