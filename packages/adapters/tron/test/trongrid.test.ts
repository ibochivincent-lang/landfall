import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { fetchTransactionSucceeded, fetchTrc20Transfers } from "../src/trongrid.js";

const ANCHOR = "TAnchor1111111111111111111111111111";
const CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

/** Two-page TronGrid fixture: page 1 (full, limit=2) links to page 2 (short) via fingerprint. */
async function mockTronGrid(): Promise<{ server: Server; base: string }> {
  const page1 = {
    success: true,
    data: [
      {
        transaction_id: "tx1",
        token_info: { symbol: "USDT", decimals: 6 },
        from: "TUSER1",
        to: ANCHOR,
        value: "5000000",
        block_timestamp: 1_700_000_000_000,
        type: "Transfer",
      },
      {
        transaction_id: "tx2",
        token_info: { symbol: "USDT", decimals: 6 },
        from: "TUSER2",
        to: ANCHOR,
        value: "2000000",
        block_timestamp: 1_700_000_001_000,
        type: "Transfer",
      },
    ],
    meta: { fingerprint: "cursor-2" },
  };
  const page2 = {
    success: true,
    data: [
      {
        transaction_id: "tx3",
        token_info: { symbol: "USDT", decimals: 6 },
        from: "TUSER3",
        to: ANCHOR,
        value: "1000000",
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
      if (body.value === "tx-success") {
        res.end(JSON.stringify({ receipt: { result: "SUCCESS" } }));
      } else if (body.value === "tx-failed") {
        res.end(JSON.stringify({ receipt: { result: "FAILED" } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({}));
      }
      return;
    }

    if (url.pathname.startsWith("/v1/accounts/") && url.pathname.endsWith("/transactions/trc20")) {
      const fingerprint = url.searchParams.get("fingerprint");
      res.end(JSON.stringify(fingerprint === "cursor-2" ? page2 : page1));
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

test("fetchTrc20Transfers follows the fingerprint cursor across pages", async () => {
  const { server, base } = await mockTronGrid();
  try {
    const transfers = await fetchTrc20Transfers({
      apiBase: base,
      address: ANCHOR,
      contractAddress: CONTRACT,
      onlyTo: true,
      limit: 2,
    });
    assert.equal(transfers.length, 3);
    assert.deepEqual(transfers.map((t) => t.transactionId), ["tx1", "tx2", "tx3"]);
    assert.equal(transfers[0]?.value, 5_000_000n);
    assert.equal(transfers[0]?.observedAt, new Date(1_700_000_000_000).toISOString());
  } finally {
    server.close();
  }
});

test("fetchTransactionSucceeded reports SUCCESS/FAILED/unknown correctly", async () => {
  const { server, base } = await mockTronGrid();
  try {
    assert.equal(await fetchTransactionSucceeded({ apiBase: base, transactionId: "tx-success" }), true);
    assert.equal(await fetchTransactionSucceeded({ apiBase: base, transactionId: "tx-failed" }), false);
    assert.equal(await fetchTransactionSucceeded({ apiBase: base, transactionId: "tx-missing" }), false);
  } finally {
    server.close();
  }
});
