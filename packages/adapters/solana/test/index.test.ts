import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { SolanaAdapter, type FiatLegProofBinder } from "../src/index.js";
import type { SettlementEvent } from "../../src/types.js";

const TOKEN_ACCOUNT = "TokenAcct1111111111111111111111111111111";
const OWNER = "Owner111111111111111111111111111111111111";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

const SIGNATURES = [
  { signature: "sig-deposit", slot: 300, err: null, blockTime: 3000 },
  { signature: "sig-failed", slot: 250, err: { InstructionError: [0, "Custom"] }, blockTime: 2500 },
  { signature: "sig-withdrawal", slot: 200, err: null, blockTime: 2000 },
];

function balance(amount: number) {
  return { accountIndex: 1, mint: MINT_USDC, owner: OWNER, uiTokenAmount: { amount: String(amount), decimals: 6 } };
}

const TRANSACTIONS: Record<string, unknown> = {
  "sig-deposit": {
    blockTime: 3000,
    meta: { err: null, preTokenBalances: [balance(1_000_000)], postTokenBalances: [balance(6_000_000)] },
    transaction: { message: { accountKeys: ["FeePayer", TOKEN_ACCOUNT] } },
  },
  "sig-withdrawal": {
    blockTime: 2000,
    meta: { err: null, preTokenBalances: [balance(6_000_000)], postTokenBalances: [balance(3_000_000)] },
    transaction: { message: { accountKeys: ["FeePayer", TOKEN_ACCOUNT] } },
  },
};

async function mockRpc(): Promise<{ server: Server; base: string; getTransactionCalls: string[] }> {
  const getTransactionCalls: string[] = [];
  const server = createServer(async (req, res) => {
    const parsed = JSON.parse(await readBody(req)) as { id: number; method: string; params: unknown[] };
    res.setHeader("content-type", "application/json");
    let result: unknown;
    if (parsed.method === "getSignaturesForAddress") {
      result = SIGNATURES;
    } else if (parsed.method === "getTransaction") {
      const sig = parsed.params[0] as string;
      getTransactionCalls.push(sig);
      result = TRANSACTIONS[sig] ?? null;
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}`, getTransactionCalls });
    });
  });
}

/** Proves only the deposit, so the test can tell "bound" apart from "not bound." */
const testBinder: FiatLegProofBinder = {
  async bind(delta) {
    if (delta.signature === "sig-deposit") return { kind: "zktls", ref: "zktls-proof-1" };
    return null;
  },
};

test("scan() skips a failed signature without spending an RPC call, and emits nothing with the default binder", async () => {
  const { server, base, getTransactionCalls } = await mockRpc();
  try {
    const adapter = new SolanaAdapter({ rpcUrl: base });
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(TOKEN_ACCOUNT, {})) events.push(ev);
    assert.equal(events.length, 0);
    assert.ok(!getTransactionCalls.includes("sig-failed"));
    assert.deepEqual(getTransactionCalls.sort(), ["sig-deposit", "sig-withdrawal"]);
  } finally {
    server.close();
  }
});

test("scan() emits only the balance change a proof was bound to", async () => {
  const { server, base } = await mockRpc();
  try {
    const adapter = new SolanaAdapter({ rpcUrl: base, fiatLegProofBinder: testBinder });
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(TOKEN_ACCOUNT, {})) events.push(ev);

    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.equal(ev.onchainRef, "sig-deposit");
    assert.equal(ev.chain, "solana");
    assert.equal(ev.direction, "deposit");
    assert.equal(ev.asset, "USDC");
    assert.equal(ev.amount, "5");
    assert.equal(ev.evidenceTier, "DERIVED");
    assert.equal(ev.evidenceDetail, "solana_transfer+zktls");
    assert.equal(ev.fiatLegRef, "zktls-proof-1");
    assert.equal(ev.keystoneRef, null);
  } finally {
    server.close();
  }
});

test("verify() reflects the on-chain outcome", async () => {
  const { server, base } = await mockRpc();
  try {
    const adapter = new SolanaAdapter({ rpcUrl: base });
    const base_: SettlementEvent = {
      anchorId: TOKEN_ACCOUNT,
      chain: "solana",
      asset: "USDC",
      direction: "deposit",
      amount: "5",
      onchainRef: "sig-deposit",
      evidenceTier: "DERIVED",
      evidenceDetail: "solana_transfer+zktls",
      observedAt: new Date(3000 * 1000).toISOString(),
    };
    assert.equal(await adapter.verify(base_), true);
    assert.equal(await adapter.verify({ ...base_, onchainRef: "sig-failed" }), false);
    assert.equal(await adapter.verify({ ...base_, chain: "tron" }), false);
  } finally {
    server.close();
  }
});
