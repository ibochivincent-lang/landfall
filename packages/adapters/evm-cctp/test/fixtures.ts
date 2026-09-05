import { TOPIC0_DEPOSIT_FOR_BURN } from "../src/abi.js";

export interface DepositForBurnFields {
  nonce: bigint;
  burnToken: string;
  depositor: string;
  amount: bigint;
  mintRecipient: string;
  destinationDomain: number;
  destinationTokenMessenger: string;
  destinationCaller: string;
}

function word(hex: string): string {
  return hex.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

/**
 * Hand-encodes a synthetic DepositForBurn log the same way the real
 * TokenMessenger contract would — used to test the decoder against known
 * inputs without depending on any externally-sourced example log.
 */
export function encodeDepositForBurnLog(fields: DepositForBurnFields): {
  topics: string[];
  data: string;
} {
  return {
    topics: [
      TOPIC0_DEPOSIT_FOR_BURN,
      "0x" + word(fields.nonce.toString(16)),
      "0x" + word(fields.burnToken),
      "0x" + word(fields.depositor),
    ],
    data:
      "0x" +
      word(fields.amount.toString(16)) +
      word(fields.mintRecipient) +
      word(fields.destinationDomain.toString(16)) +
      word(fields.destinationTokenMessenger) +
      word(fields.destinationCaller),
  };
}

export const DEPOSITOR = "0x" + "11".repeat(20);
export const BURN_TOKEN = "0x" + "22".repeat(20);
export const MINT_RECIPIENT = "0x" + "33".repeat(32);
export const DEST_TOKEN_MESSENGER = "0x" + "44".repeat(32);
export const NO_CALLER_RESTRICTION = "0x" + "00".repeat(32);
