import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { EvmCctpAdapter } from "../src/index.js";
import type { SettlementEvent } from "../../src/types.js";
import {
  BURN_TOKEN,
  DEPOSITOR,
  DEST_TOKEN_MESSENGER,
  encodeDepositForBurnLog,
  MINT_RECIPIENT,
  NO_CALLER_RESTRICTION,
} from "./fixtures.js";

const TOKEN_MESSENGER = "0x" + "55".repeat(20);
const BLOCK_NUMBER = "0x64"; // 100
const BLOCK_TIMESTAMP_HEX = "0x67200000"; // arbitrary fixed unix seconds
const EXPECTED_ISO = new Date(Number(BigInt(BLOCK_TIMESTAMP_HEX)) * 1000).toISOString();

const TX_COMPLETE_LARGE = "0x" + "a1".repeat(32); // 5 USDC, attestation complete
const TX_PENDING = "0x" + "b2".repeat(32); // 2.5 USDC, attestation still pending
const TX_COMPLETE_SMALL = "0x" + "c3".repeat(32); // 1 USDC, attestation complete

function burnLog(txHash: string, amount: bigint) {
  const { topics, data } = encodeDepositForBurnLog({
    nonce: 1n,
    burnToken: BURN_TOKEN,
    depositor: DEPOSITOR,
    amount,
    mintRecipient: MINT_RECIPIENT,
    destinationDomain: 6,
    destinationTokenMessenger: DEST_TOKEN_MESSENGER,
    destinationCaller: NO_CALLER_RESTRICTION,
  });
  return { address: TOKEN_MESSENGER, topics, data, transactionHash: txHash, blockNumber: BLOCK_NUMBER };
}

const LOGS = [
  burnLog(TX_COMPLETE_LARGE, 5_000_000n),
  burnLog(TX_PENDING, 2_500_000n),
  burnLog(TX_COMPLETE_SMALL, 1_000_000n),
];

const IRIS_MESSAGES: Record<string, unknown> = {
  [TX_COMPLETE_LARGE]: { messages: [{ attestation: "0xsig1", message: "0x00", eventNonce: "1", status: "complete" }] },
  [TX_PENDING]: { messages: [{ attestation: null, message: "0x00", eventNonce: "2", status: "pending_confirmations" }] },
  [TX_COMPLETE_SMALL]: { messages: [{ attestation: "0xsig3", message: "0x00", eventNonce: "3", status: "complete" }] },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

async function mockRpc(): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw);
    res.setHeader("content-type", "application/json");

    if (Array.isArray(parsed)) {
      // batched eth_getBlockByNumber
      const results = parsed.map((item: { id: number }) => ({
        id: item.id,
        result: { timestamp: BLOCK_TIMESTAMP_HEX },
      }));
      res.end(JSON.stringify(results));
      return;
    }

    if (parsed.method === "eth_getLogs") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: LOGS }));
      return;
    }

    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: -1, message: `unexpected method ${parsed.method}` } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function mockIris(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const txHash = req.url?.split("/").pop() ?? "";
    const body = IRIS_MESSAGES[txHash];
    if (!body) {
      res.statusCode = 404;
      res.end(JSON.stringify({}));
      return;
    }
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function withMocks(
  run: (adapter: EvmCctpAdapter) => Promise<void>,
): Promise<void> {
  const rpc = await mockRpc();
  const iris = await mockIris();
  try {
    const adapter = new EvmCctpAdapter({
      chain: "base",
      rpcUrl: rpc.base,
      tokenMessengerAddress: TOKEN_MESSENGER,
      sourceDomainId: 6,
      irisApiBase: iris.base,
    });
    await run(adapter);
  } finally {
    rpc.server.close();
    iris.server.close();
  }
}

test("scan() only emits burns whose Iris attestation is complete", async () => {
  await withMocks(async (adapter) => {
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(DEPOSITOR, {})) events.push(ev);

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.onchainRef).sort(),
      [TX_COMPLETE_LARGE, TX_COMPLETE_SMALL].sort(),
    );
    assert.ok(events.every((e) => e.chain === "base"));
    assert.ok(events.every((e) => e.evidenceTier === "ATTESTED"));
    assert.ok(events.every((e) => e.evidenceDetail === "cctp_burn+iris"));
    assert.ok(events.every((e) => e.direction === "bridge_out"));
    assert.ok(events.every((e) => e.asset === "USDC"));
    assert.ok(events.every((e) => e.keystoneRef === null));

    const large = events.find((e) => e.onchainRef === TX_COMPLETE_LARGE);
    assert.equal(large?.amount, "5");
    assert.equal(large?.observedAt, EXPECTED_ISO);
  });
});

test("scan() applies minAmount on top of the attestation-completeness filter", async () => {
  await withMocks(async (adapter) => {
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(DEPOSITOR, { minAmount: "2" })) events.push(ev);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.onchainRef, TX_COMPLETE_LARGE);
  });
});

test("verify() confirms a completed attestation and rejects a pending or wrong-chain one", async () => {
  await withMocks(async (adapter) => {
    const base: SettlementEvent = {
      anchorId: DEPOSITOR,
      chain: "base",
      asset: "USDC",
      direction: "bridge_out",
      amount: "5",
      onchainRef: TX_COMPLETE_LARGE,
      evidenceTier: "ATTESTED",
      evidenceDetail: "cctp_burn+iris",
      observedAt: EXPECTED_ISO,
    };
    assert.equal(await adapter.verify(base), true);
    assert.equal(await adapter.verify({ ...base, onchainRef: TX_PENDING }), false);
    assert.equal(await adapter.verify({ ...base, chain: "arbitrum" }), false);
  });
});
