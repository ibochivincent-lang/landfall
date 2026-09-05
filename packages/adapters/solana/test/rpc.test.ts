import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { getSignaturesForAddress, getTokenBalanceDelta, transactionSucceeded } from "../src/rpc.js";

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

function rpcServer(handlers: Record<string, (params: unknown[]) => unknown>): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    const parsed = JSON.parse(await readBody(req)) as { id: number; method: string; params: unknown[] };
    res.setHeader("content-type", "application/json");
    const handler = handlers[parsed.method];
    if (!handler) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: "no handler" } }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: handler(parsed.params) }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test("getSignaturesForAddress follows `before` across pages until a short page", async () => {
  const page1 = [
    { signature: "sig3", slot: 300, err: null, blockTime: 3000 },
    { signature: "sig2", slot: 200, err: null, blockTime: 2000 },
  ];
  const page2 = [{ signature: "sig1", slot: 100, err: null, blockTime: 1000 }];

  const { server, base } = await rpcServer({
    getSignaturesForAddress: (params) => {
      const opts = params[1] as { before?: string; limit: number };
      return opts.before === "sig2" ? page2 : page1;
    },
  });
  try {
    const sigs = await getSignaturesForAddress({ rpcUrl: base, address: TOKEN_ACCOUNT, limit: 2 });
    assert.deepEqual(sigs.map((s) => s.signature), ["sig3", "sig2", "sig1"]);
  } finally {
    server.close();
  }
});

test("getSignaturesForAddress stops at stopAtSlot without reading past the boundary", async () => {
  const page = [
    { signature: "sig3", slot: 300, err: null, blockTime: 3000 },
    { signature: "sig2", slot: 200, err: null, blockTime: 2000 },
    { signature: "sig1", slot: 100, err: null, blockTime: 1000 },
  ];
  const { server, base } = await rpcServer({ getSignaturesForAddress: () => page });
  try {
    const sigs = await getSignaturesForAddress({ rpcUrl: base, address: TOKEN_ACCOUNT, stopAtSlot: 200 });
    assert.deepEqual(sigs.map((s) => s.signature), ["sig3", "sig2"]);
  } finally {
    server.close();
  }
});

function txFixture(opts: {
  err?: unknown;
  blockTime?: number | null;
  pre?: number;
  post?: number;
  accountIndex?: number;
}) {
  const accountIndex = opts.accountIndex ?? 1;
  const accountKeys = ["FeePayer1111111111111111111111111111111111"];
  accountKeys[accountIndex] = TOKEN_ACCOUNT;

  const balance = (amount: number) => ({
    accountIndex,
    mint: MINT_USDC,
    owner: OWNER,
    uiTokenAmount: { amount: String(amount), decimals: 6 },
  });

  return {
    blockTime: opts.blockTime === undefined ? 1_700_000_000 : opts.blockTime,
    meta: {
      err: opts.err ?? null,
      preTokenBalances: opts.pre !== undefined ? [balance(opts.pre)] : [],
      postTokenBalances: opts.post !== undefined ? [balance(opts.post)] : [],
    },
    transaction: { message: { accountKeys } },
  };
}

test("getTokenBalanceDelta reports a positive delta for an inbound transfer", async () => {
  const { server, base } = await rpcServer({
    getTransaction: () => txFixture({ pre: 1_000_000, post: 6_000_000 }),
  });
  try {
    const change = await getTokenBalanceDelta({ rpcUrl: base, signature: "sig-in", tokenAccount: TOKEN_ACCOUNT });
    assert.equal(change?.delta, 5_000_000n);
    assert.equal(change?.owner, OWNER);
    assert.equal(change?.mint, MINT_USDC);
    assert.equal(change?.observedAt, new Date(1_700_000_000 * 1000).toISOString());
  } finally {
    server.close();
  }
});

test("getTokenBalanceDelta reports a negative delta for an outbound transfer", async () => {
  const { server, base } = await rpcServer({
    getTransaction: () => txFixture({ pre: 6_000_000, post: 3_000_000 }),
  });
  try {
    const change = await getTokenBalanceDelta({ rpcUrl: base, signature: "sig-out", tokenAccount: TOKEN_ACCOUNT });
    assert.equal(change?.delta, -3_000_000n);
  } finally {
    server.close();
  }
});

test("getTokenBalanceDelta treats a missing pre-balance as zero (account created in this tx)", async () => {
  const { server, base } = await rpcServer({
    getTransaction: () => txFixture({ post: 2_000_000 }), // no `pre` supplied
  });
  try {
    const change = await getTokenBalanceDelta({ rpcUrl: base, signature: "sig-new", tokenAccount: TOKEN_ACCOUNT });
    assert.equal(change?.delta, 2_000_000n);
  } finally {
    server.close();
  }
});

function untouchedTxFixture() {
  return {
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint: MINT_USDC, owner: OWNER, uiTokenAmount: { amount: "1", decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT_USDC, owner: OWNER, uiTokenAmount: { amount: "2", decimals: 6 } },
      ],
    },
    // TOKEN_ACCOUNT does not appear anywhere here — this is a transaction that never touched it.
    transaction: { message: { accountKeys: ["FeePayer1111111111111111111111111111111111", "SomeOtherTokenAcct"] } },
  };
}

test("getTokenBalanceDelta returns null for a failed transaction, a zero delta, or an untouched account", async () => {
  const { server, base } = await rpcServer({
    getTransaction: (params) => {
      const sig = params[0] as string;
      if (sig === "sig-failed") return txFixture({ err: { InstructionError: [0, "Custom"] }, pre: 1, post: 2 });
      if (sig === "sig-zero") return txFixture({ pre: 5_000_000, post: 5_000_000 });
      if (sig === "sig-untouched") return untouchedTxFixture();
      return null;
    },
  });
  try {
    assert.equal(await getTokenBalanceDelta({ rpcUrl: base, signature: "sig-failed", tokenAccount: TOKEN_ACCOUNT }), null);
    assert.equal(await getTokenBalanceDelta({ rpcUrl: base, signature: "sig-zero", tokenAccount: TOKEN_ACCOUNT }), null);
    assert.equal(await getTokenBalanceDelta({ rpcUrl: base, signature: "sig-untouched", tokenAccount: TOKEN_ACCOUNT }), null);
    assert.equal(await getTokenBalanceDelta({ rpcUrl: base, signature: "sig-missing", tokenAccount: TOKEN_ACCOUNT }), null);
  } finally {
    server.close();
  }
});

test("transactionSucceeded reflects meta.err and a missing transaction", async () => {
  const { server, base } = await rpcServer({
    getTransaction: (params) => {
      const sig = params[0] as string;
      if (sig === "sig-ok") return txFixture({ pre: 1, post: 2 });
      if (sig === "sig-bad") return txFixture({ err: { InstructionError: [0, "Custom"] } });
      return null;
    },
  });
  try {
    assert.equal(await transactionSucceeded({ rpcUrl: base, signature: "sig-ok" }), true);
    assert.equal(await transactionSucceeded({ rpcUrl: base, signature: "sig-bad" }), false);
    assert.equal(await transactionSucceeded({ rpcUrl: base, signature: "sig-missing" }), false);
  } finally {
    server.close();
  }
});
