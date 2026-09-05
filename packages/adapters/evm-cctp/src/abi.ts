import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * event DepositForBurn(
 *   uint64 indexed nonce,
 *   address indexed burnToken,
 *   uint256 amount,
 *   address indexed depositor,
 *   bytes32 mintRecipient,
 *   uint32 destinationDomain,
 *   bytes32 destinationTokenMessenger,
 *   bytes32 destinationCaller
 * );
 *
 * Verbatim from circlefin/evm-cctp-contracts, src/TokenMessenger.sol.
 * https://github.com/circlefin/evm-cctp-contracts/blob/master/src/TokenMessenger.sol
 */
const DEPOSIT_FOR_BURN_SIGNATURE =
  "DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32)";

/**
 * Computed at load time from the signature above, rather than hardcoded as
 * a bare hex constant — this way the value is derived from something
 * reviewable (the signature string), not an opaque hash that silently goes
 * stale or wrong if the signature ever needs correcting.
 */
export const TOPIC0_DEPOSIT_FOR_BURN = "0x" + toHex(keccak_256(new TextEncoder().encode(DEPOSIT_FOR_BURN_SIGNATURE)));

export interface DecodedDepositForBurn {
  nonce: bigint;
  burnToken: string;
  depositor: string;
  amount: bigint;
  /** 32-byte recipient identifier — not necessarily an EVM address, the destination may be any CCTP-supported chain. */
  mintRecipient: string;
  destinationDomain: number;
  destinationTokenMessenger: string;
  destinationCaller: string;
}

/** Minimal shape of an eth_getLogs entry — only what decoding needs. */
export interface EthLogLike {
  topics: string[];
  data: string;
}

const WORD_HEX_LEN = 64; // 32 bytes, hex-encoded, no 0x prefix

/**
 * Decodes a raw eth_getLogs entry into a DepositForBurn event. Throws on
 * anything malformed rather than returning null: a log that matched our
 * topic0 filter but doesn't decode cleanly is a decoder bug or an RPC
 * lying to us, not a record to silently drop.
 */
export function decodeDepositForBurnLog(log: EthLogLike): DecodedDepositForBurn {
  if (log.topics.length !== 4) {
    throw new Error(`DepositForBurn log must carry exactly 4 topics, got ${log.topics.length}`);
  }
  const [topic0, nonceTopic, burnTokenTopic, depositorTopic] = log.topics as [string, string, string, string];
  if (topic0.toLowerCase() !== TOPIC0_DEPOSIT_FOR_BURN.toLowerCase()) {
    throw new Error(`log topic0 ${topic0} does not match DepositForBurn (${TOPIC0_DEPOSIT_FOR_BURN})`);
  }

  const data = stripHexPrefix(log.data);
  const expectedLen = 5 * WORD_HEX_LEN;
  if (data.length !== expectedLen) {
    throw new Error(`DepositForBurn data must be ${expectedLen} hex chars (5 words), got ${data.length}`);
  }
  const word = (i: number) => data.slice(i * WORD_HEX_LEN, (i + 1) * WORD_HEX_LEN);

  return {
    nonce: BigInt(nonceTopic),
    burnToken: topicToAddress(burnTokenTopic),
    depositor: topicToAddress(depositorTopic),
    amount: BigInt(prefixHex(word(0))),
    mintRecipient: prefixHex(word(1)),
    destinationDomain: Number(BigInt(prefixHex(word(2)))),
    destinationTokenMessenger: prefixHex(word(3)),
    destinationCaller: prefixHex(word(4)),
  };
}

/** Left-pads an EVM address into the 32-byte topic form eth_getLogs filters expect. */
export function encodeAddressTopic(address: string): string {
  return prefixHex(stripHexPrefix(address).toLowerCase().padStart(WORD_HEX_LEN, "0"));
}

function topicToAddress(topic: string): string {
  const hex = stripHexPrefix(topic).padStart(WORD_HEX_LEN, "0");
  return prefixHex(hex.slice(-40));
}

function stripHexPrefix(v: string): string {
  return v.startsWith("0x") || v.startsWith("0X") ? v.slice(2) : v;
}

function prefixHex(v: string): string {
  return "0x" + v;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
