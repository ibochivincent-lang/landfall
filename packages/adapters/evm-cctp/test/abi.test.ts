import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeDepositForBurnLog, encodeAddressTopic, TOPIC0_DEPOSIT_FOR_BURN } from "../src/abi.js";
import {
  BURN_TOKEN,
  DEPOSITOR,
  DEST_TOKEN_MESSENGER,
  encodeDepositForBurnLog,
  MINT_RECIPIENT,
  NO_CALLER_RESTRICTION,
} from "./fixtures.js";

test("TOPIC0_DEPOSIT_FOR_BURN is a well-formed 32-byte hash", () => {
  assert.match(TOPIC0_DEPOSIT_FOR_BURN, /^0x[0-9a-f]{64}$/);
});

test("decodeDepositForBurnLog round-trips every field of a synthetic log", () => {
  const fields = {
    nonce: 42n,
    burnToken: BURN_TOKEN,
    depositor: DEPOSITOR,
    amount: 5_000_000n,
    mintRecipient: MINT_RECIPIENT,
    destinationDomain: 6,
    destinationTokenMessenger: DEST_TOKEN_MESSENGER,
    destinationCaller: NO_CALLER_RESTRICTION,
  };
  const log = encodeDepositForBurnLog(fields);
  const decoded = decodeDepositForBurnLog(log);

  assert.equal(decoded.nonce, fields.nonce);
  assert.equal(decoded.burnToken.toLowerCase(), fields.burnToken.toLowerCase());
  assert.equal(decoded.depositor.toLowerCase(), fields.depositor.toLowerCase());
  assert.equal(decoded.amount, fields.amount);
  assert.equal(decoded.mintRecipient.toLowerCase(), fields.mintRecipient.toLowerCase());
  assert.equal(decoded.destinationDomain, fields.destinationDomain);
  assert.equal(decoded.destinationTokenMessenger.toLowerCase(), fields.destinationTokenMessenger.toLowerCase());
  assert.equal(decoded.destinationCaller.toLowerCase(), fields.destinationCaller.toLowerCase());
});

test("decodeDepositForBurnLog rejects a log with the wrong topic0", () => {
  const log = encodeDepositForBurnLog({
    nonce: 1n,
    burnToken: BURN_TOKEN,
    depositor: DEPOSITOR,
    amount: 1n,
    mintRecipient: MINT_RECIPIENT,
    destinationDomain: 6,
    destinationTokenMessenger: DEST_TOKEN_MESSENGER,
    destinationCaller: NO_CALLER_RESTRICTION,
  });
  log.topics[0] = "0x" + "ff".repeat(32);
  assert.throws(() => decodeDepositForBurnLog(log), /does not match DepositForBurn/);
});

test("decodeDepositForBurnLog rejects the wrong topic count", () => {
  assert.throws(
    () => decodeDepositForBurnLog({ topics: [TOPIC0_DEPOSIT_FOR_BURN], data: "0x" }),
    /exactly 4 topics/,
  );
});

test("decodeDepositForBurnLog rejects malformed data length", () => {
  const log = encodeDepositForBurnLog({
    nonce: 1n,
    burnToken: BURN_TOKEN,
    depositor: DEPOSITOR,
    amount: 1n,
    mintRecipient: MINT_RECIPIENT,
    destinationDomain: 6,
    destinationTokenMessenger: DEST_TOKEN_MESSENGER,
    destinationCaller: NO_CALLER_RESTRICTION,
  });
  log.data = log.data.slice(0, -2); // drop the last byte
  assert.throws(() => decodeDepositForBurnLog(log), /5 words/);
});

test("encodeAddressTopic left-pads an address into 32-byte topic form", () => {
  assert.equal(encodeAddressTopic(DEPOSITOR), "0x" + "0".repeat(24) + "11".repeat(20));
});
