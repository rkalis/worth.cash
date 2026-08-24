import { type Filter, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC } from 'lib/events';
import { addressToTopic } from 'lib/events/utils';
import type { Address } from 'viem';

// Every way a token balance can change for an address, as a set of log filters.
//
// This differs from the revoke.cash equivalent, which only needs outbound transfers because an approval is
// only interesting once you have interacted with a token. A portfolio needs inbound transfers too, since
// that is how tokens are acquired in the first place.
//
// ERC20 and ERC721 share a topic0 and index the owner at topic1 (from) and topic2 (to). ERC1155 indexes an
// extra `operator` parameter first, so its owner topics are shifted one position to topic2 and topic3.
export const buildTransferFilters = (address: Address, fromBlock: number, toBlock: number): Record<string, Filter> => {
  const addressTopic = addressToTopic(address);

  return {
    'Transfer (out)': { topics: [TRANSFER_TOPIC, addressTopic], fromBlock, toBlock },
    'Transfer (in)': { topics: [TRANSFER_TOPIC, null, addressTopic], fromBlock, toBlock },
    'TransferSingle (out)': { topics: [TRANSFER_SINGLE_TOPIC, null, addressTopic], fromBlock, toBlock },
    'TransferSingle (in)': { topics: [TRANSFER_SINGLE_TOPIC, null, null, addressTopic], fromBlock, toBlock },
    'TransferBatch (out)': { topics: [TRANSFER_BATCH_TOPIC, null, addressTopic], fromBlock, toBlock },
    'TransferBatch (in)': { topics: [TRANSFER_BATCH_TOPIC, null, null, addressTopic], fromBlock, toBlock },
  };
};
