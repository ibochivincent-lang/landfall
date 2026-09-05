import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { TronAdapter, USDT_TRC20_CONTRACT, type FiatLegProofBinder } from "../src/index.js";
import type { SettlementEvent } from "../../src/types.js";

const ANCHOR = "TAnchor1111111111111111111111111111";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

async function mockTronGrid(): Promise<{ server: Server; base: string }> {
  const inboundPage = {
    success: true,
    data: [
      {
        transaction_id: "tx-in-1",
        token_info: { symbol: "USDT", decimals: 6 },
        from: "TUSER1",
        to: ANCHOR,
        value: "5000000",
        block_timestamp: 1_700_000_000_000,
        type: "Transfer",
      },
      {
        transaction_id: "tx-in-2",
        token_info: { symbol: "USDT", decimals: 6 },
        from: "TUSER2",
        to: ANCHOR,
        value: "1000000",
        block_timestamp: 1_700_000_001_000,
        type: "Transfer",
      },
    ],
    meta: {},
  };
  const outboundPage = {
    success: true,
    data: [
      {
        transaction_id: "tx-out-1",
        token_info: { symbol: "USDT", decimals: 6 },
        from: ANCHOR,
        to: "TUSER3",
        value: "3000000",
        block_timestamp: 1_700_000_002_000,
        type: "Transfer",
      },
    ],
    meta: {},
  };

  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "", "http://localhost");

    if (url.pathname === "/walletsolidity/gettransactioninfobyid" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { value: string };
      res.end(JSON.stringify({ receipt: { result: body.value === "tx-in-1" ? "SUCCESS" : "FAILED" } }));
      return;
    }

    if (url.pathname === `/v1/accounts/${ANCHOR}/transactions/trc20`) {
      const onlyTo = url.searchParams.get("only_to") === "true";
      res.end(JSON.stringify(onlyTo ? inboundPage : outboundPage));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({}));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

/** Proves only tx-in-1 and tx-out-1, so the test can tell "bound" apart from "not bound" and from "filtered by amount." */
const testBinder: FiatLegProofBinder = {
  async bind(transfer) {
    if (transfer.transactionId === "tx-in-1") return { kind: "zktls", ref: "zktls-proof-1" };
    if (transfer.transactionId === "tx-out-1") return { kind: "proof_of_reserve", ref: "por-proof-1" };
    return null;
  },
};

test("scan() with the default binder emits nothing — no proof, no DERIVED claim", async () => {
  const { server, base } = await mockTronGrid();
  try {
    const adapter = new TronAdapter({ apiBase: base });
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(ANCHOR, {})) events.push(ev);
    assert.equal(events.length, 0);
  } finally {
    server.close();
  }
});

test("scan() emits only transfers a proof was actually bound to, tagged with the proof's kind", async () => {
  const { server, base } = await mockTronGrid();
  try {
    const adapter = new TronAdapter({ apiBase: base, fiatLegProofBinder: testBinder });
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(ANCHOR, {})) events.push(ev);

    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.chain === "tron"));
    assert.ok(events.every((e) => e.evidenceTier === "DERIVED"));
    assert.ok(events.every((e) => e.asset === "USDT"));

    const inbound = events.find((e) => e.onchainRef === "tx-in-1");
    assert.equal(inbound?.direction, "deposit");
    assert.equal(inbound?.amount, "5");
    assert.equal(inbound?.fiatLegRef, "zktls-proof-1");
    assert.equal(inbound?.evidenceDetail, "tron_transfer+zktls");

    const outbound = events.find((e) => e.onchainRef === "tx-out-1");
    assert.equal(outbound?.direction, "withdrawal");
    assert.equal(outbound?.amount, "3");
    assert.equal(outbound?.fiatLegRef, "por-proof-1");
    assert.equal(outbound?.evidenceDetail, "tron_transfer+proof_of_reserve");
  } finally {
    server.close();
  }
});

test("scan() applies minAmount before consulting the proof binder", async () => {
  const { server, base } = await mockTronGrid();
  try {
    const adapter = new TronAdapter({ apiBase: base, fiatLegProofBinder: testBinder, usdtContractAddress: USDT_TRC20_CONTRACT });
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(ANCHOR, { minAmount: "4" })) events.push(ev);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.onchainRef, "tx-in-1");
  } finally {
    server.close();
  }
});

test("verify() reflects the on-chain outcome independently of any bound proof", async () => {
  const { server, base } = await mockTronGrid();
  try {
    const adapter = new TronAdapter({ apiBase: base });
    const base_: SettlementEvent = {
      anchorId: ANCHOR,
      chain: "tron",
      asset: "USDT",
      direction: "deposit",
      amount: "5",
      onchainRef: "tx-in-1",
      evidenceTier: "DERIVED",
      evidenceDetail: "tron_transfer+zktls",
      observedAt: new Date().toISOString(),
    };
    assert.equal(await adapter.verify(base_), true);
    assert.equal(await adapter.verify({ ...base_, onchainRef: "tx-in-2" }), false);
    assert.equal(await adapter.verify({ ...base_, chain: "ethereum" }), false);
  } finally {
    server.close();
  }
});
