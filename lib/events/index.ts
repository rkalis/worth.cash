import { ERC20_ABI, ERC721_ABI, ERC1155_ABI } from 'lib/abis';
import { isNullish } from 'lib/utils';
import { type Address, decodeAbiParameters, getAbiItem, type Hash, type Hex, toEventSelector } from 'viem';
import { topicToAddress } from './utils';

// Topic-0 selectors for every event we parse, computed once at import.
// ERC20 and ERC721 share the Transfer(address,address,uint256) signature, so their topics are identical;
// they are told apart by how many of the parameters are indexed. See `parseTransferLog`.
export const TRANSFER_TOPIC = toEventSelector(getAbiItem({ abi: ERC20_ABI, name: 'Transfer' }));
export const TRANSFER_SINGLE_TOPIC = toEventSelector(getAbiItem({ abi: ERC1155_ABI, name: 'TransferSingle' }));
export const TRANSFER_BATCH_TOPIC = toEventSelector(getAbiItem({ abi: ERC1155_ABI, name: 'TransferBatch' }));
export const ERC721_TRANSFER_TOPIC = toEventSelector(getAbiItem({ abi: ERC721_ABI, name: 'Transfer' }));

export interface Log {
  address: Address;
  topics: [topic0: Hex, ...rest: Hex[]];
  data: Hex;
  transactionHash: Hash;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  timestamp?: number;
}

export type LogPosition = Pick<Log, 'blockNumber' | 'transactionIndex' | 'logIndex'>;

export interface EventTimeLog extends LogPosition {
  transactionHash: Hash;
  timestamp?: number;
}

export interface Filter {
  address?: Address;
  topics: Array<Hex | null>;
  fromBlock: number;
  toBlock: number;
}

export type TokenStandard = 'erc20' | 'erc721' | 'erc1155';

export interface TransferEvent {
  chainId: number;
  standard: TokenStandard;
  token: Address;
  from: Address;
  to: Address;
  // For ERC20 this is the transferred amount in base units. For ERC721 it is always 1. For ERC1155 it is
  // the transferred quantity of that particular token id.
  amount: bigint;
  // Undefined for ERC20, which has no token ids.
  tokenId?: bigint;
  time: EventTimeLog;
}

const toEventTimeLog = (log: Log): EventTimeLog => ({
  transactionHash: log.transactionHash,
  blockNumber: log.blockNumber,
  transactionIndex: log.transactionIndex,
  logIndex: log.logIndex,
  timestamp: log.timestamp,
});

// A single uint256 packed into the log data. Spam contracts routinely emit malformed data, so a failure
// to decode is treated as a zero rather than as a reason to abandon the whole batch of logs.
const decodeUint256 = (data: Hex): bigint => {
  if (isNullish(data) || data === '0x' || data.length < 66) return 0n;

  try {
    return BigInt(data.slice(0, 66));
  } catch {
    return 0n;
  }
};

// Turns raw logs into transfer events, dropping anything we cannot make sense of. Dropping is the right
// behaviour here: an unparseable log is either a non-standard contract or spam, and in both cases we would
// rather miss it than fail the whole chain's sync.
export const parseTransferLogs = (logs: readonly Log[], chainId: number): TransferEvent[] => {
  return logs.flatMap((log) => parseTransferLog(log, chainId) ?? []);
};

export const parseTransferLog = (log: Log, chainId: number): TransferEvent[] | undefined => {
  const [topic0, topic1, topic2, topic3] = log.topics;

  if (topic0 === TRANSFER_TOPIC) {
    return parseErc20OrErc721TransferLog(log, chainId, topic1, topic2, topic3);
  }

  if (topic0 === TRANSFER_SINGLE_TOPIC) {
    return parseTransferSingleLog(log, chainId, topic2, topic3);
  }

  if (topic0 === TRANSFER_BATCH_TOPIC) {
    return parseTransferBatchLog(log, chainId, topic2, topic3);
  }

  return undefined;
};

const parseErc20OrErc721TransferLog = (
  log: Log,
  chainId: number,
  topic1?: Hex,
  topic2?: Hex,
  topic3?: Hex,
): TransferEvent[] | undefined => {
  if (isNullish(topic1) || isNullish(topic2)) return undefined;

  const from = topicToAddress(topic1);
  const to = topicToAddress(topic2);
  const base = { chainId, token: log.address, from, to, time: toEventTimeLog(log) };

  // ERC721 indexes the token id as its third topic, so a fourth topic means this is an NFT transfer.
  if (!isNullish(topic3)) {
    return [{ ...base, standard: 'erc721', amount: 1n, tokenId: BigInt(topic3) }];
  }

  return [{ ...base, standard: 'erc20', amount: decodeUint256(log.data) }];
};

const parseTransferSingleLog = (
  log: Log,
  chainId: number,
  fromTopic?: Hex,
  toTopic?: Hex,
): TransferEvent[] | undefined => {
  if (isNullish(fromTopic) || isNullish(toTopic)) return undefined;

  try {
    const [tokenId, amount] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], log.data);

    return [
      {
        chainId,
        standard: 'erc1155',
        token: log.address,
        from: topicToAddress(fromTopic),
        to: topicToAddress(toTopic),
        amount,
        tokenId,
        time: toEventTimeLog(log),
      },
    ];
  } catch {
    return undefined;
  }
};

const parseTransferBatchLog = (
  log: Log,
  chainId: number,
  fromTopic?: Hex,
  toTopic?: Hex,
): TransferEvent[] | undefined => {
  if (isNullish(fromTopic) || isNullish(toTopic)) return undefined;

  try {
    const [tokenIds, amounts] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], log.data);
    if (tokenIds.length !== amounts.length) return undefined;

    const from = topicToAddress(fromTopic);
    const to = topicToAddress(toTopic);
    const time = toEventTimeLog(log);

    // A batch transfer becomes one event per token id, so that downstream code never needs to special-case it.
    return tokenIds.map((tokenId, index) => ({
      chainId,
      standard: 'erc1155' as const,
      token: log.address,
      from,
      to,
      amount: amounts[index],
      tokenId,
      time,
    }));
  } catch {
    return undefined;
  }
};
