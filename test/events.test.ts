import { type Log, parseTransferLogs, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC } from 'lib/events';
import { addressToTopic } from 'lib/events/utils';
import { encodeAbiParameters, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';

const baseLog = {
  address: TOKEN,
  data: '0x' as Hex,
  transactionHash: '0xabc',
  blockNumber: 100,
  transactionIndex: 0,
  logIndex: 0,
} satisfies Omit<Log, 'topics'>;

const uint256 = (value: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [value]);

describe('parseTransferLogs', () => {
  it('reads an ERC20 transfer from a three-topic log with the amount in data', () => {
    const [event] = parseTransferLogs(
      [{ ...baseLog, topics: [TRANSFER_TOPIC, addressToTopic(ALICE), addressToTopic(BOB)], data: uint256(1000n) }],
      1,
    );

    expect(event.standard).toBe('erc20');
    expect(event.amount).toBe(1000n);
    expect(event.tokenId).toBeUndefined();
    expect(event.from.toLowerCase()).toBe(ALICE);
    expect(event.to.toLowerCase()).toBe(BOB);
  });

  // ERC20 and ERC721 share a topic0, and are only distinguishable by whether the third parameter is indexed.
  it('reads an ERC721 transfer from a four-topic log with the token id in the last topic', () => {
    const [event] = parseTransferLogs(
      [
        {
          ...baseLog,
          topics: [TRANSFER_TOPIC, addressToTopic(ALICE), addressToTopic(BOB), uint256(42n)],
        },
      ],
      1,
    );

    expect(event.standard).toBe('erc721');
    expect(event.tokenId).toBe(42n);
    expect(event.amount).toBe(1n);
  });

  it('reads an ERC1155 single transfer, whose owner topics are shifted by the operator parameter', () => {
    const [event] = parseTransferLogs(
      [
        {
          ...baseLog,
          topics: [TRANSFER_SINGLE_TOPIC, addressToTopic(BOB), addressToTopic(ALICE), addressToTopic(BOB)],
          data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 3n]),
        },
      ],
      1,
    );

    expect(event.standard).toBe('erc1155');
    expect(event.tokenId).toBe(7n);
    expect(event.amount).toBe(3n);
    expect(event.from.toLowerCase()).toBe(ALICE);
    expect(event.to.toLowerCase()).toBe(BOB);
  });

  it('expands an ERC1155 batch transfer into one event per token id', () => {
    const events = parseTransferLogs(
      [
        {
          ...baseLog,
          topics: [TRANSFER_BATCH_TOPIC, addressToTopic(BOB), addressToTopic(ALICE), addressToTopic(BOB)],
          data: encodeAbiParameters(
            [{ type: 'uint256[]' }, { type: 'uint256[]' }],
            [
              [1n, 2n],
              [10n, 20n],
            ],
          ),
        },
      ],
      1,
    );

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.tokenId)).toEqual([1n, 2n]);
    expect(events.map((event) => event.amount)).toEqual([10n, 20n]);
  });

  // Spam contracts routinely emit Transfer events with malformed data, and one of them must not be able to
  // abort the parsing of an entire block range.
  it('treats malformed ERC20 data as a zero amount rather than throwing', () => {
    const [event] = parseTransferLogs(
      [{ ...baseLog, topics: [TRANSFER_TOPIC, addressToTopic(ALICE), addressToTopic(BOB)], data: '0x' }],
      1,
    );

    expect(event.amount).toBe(0n);
  });

  it('drops logs whose topic0 is not a transfer event', () => {
    const events = parseTransferLogs([{ ...baseLog, topics: ['0xdeadbeef' as Hex, addressToTopic(ALICE)] }], 1);

    expect(events).toEqual([]);
  });
});
