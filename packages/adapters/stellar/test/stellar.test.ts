import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { StellarAdapter } from "../src/index.js";
import type { SettlementEvent } from "../../src/types.js";

const ANCHOR = "GANCHOR";
const USER = "GUSER";

/** A stand-in Horizon exposing /accounts/:id/payments and /transactions/:hash. */
function mockHorizon(): Promise<{ server: Server; base: string }> {
  const payments = {
    _links: {},
    _embedded: {
      records: [
        {
          type: "payment",
          paging_token: "200",
          transaction_hash: "h2",
          from: USER,
          to: ANCHOR,
          amount: "100.0000000",
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: "GISSUER",
          created_at: "2026-03-01T06:00:00Z",
        },
        {
          type: "payment",
          paging_token: "100",
          transaction_hash: "h1",
          from: ANCHOR,
          to: USER,
          amount: "40.0000000",
          asset_type: "native",
          created_at: "2026-03-01T05:00:00Z",
        },
      ],
    },
  };

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/transactions/h2")) {
        res.end(JSON.stringify({ hash: "h2", successful: true }));
        return;
      }
      if (req.url?.includes("/transactions/hbad")) {
        res.end(JSON.stringify({ hash: "hbad", successful: false }));
        return;
      }
      if (req.url?.includes("/payments")) {
        res.end(JSON.stringify(payments));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({}));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test("scan() tags PROVEN, direction, and asset correctly for both legs", async () => {
  const { server, base } = await mockHorizon();
  try {
    const adapter = new StellarAdapter({ horizon: base });
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(ANCHOR, {})) events.push(ev);

    assert.equal(events.length, 2);
    assert.equal(adapter.chain, "stellar");
    assert.equal(adapter.maxTier, "PROVEN");

    const deposit = events.find((e) => e.onchainRef === "h2");
    assert.ok(deposit);
    assert.equal(deposit.direction, "deposit");
    assert.equal(deposit.asset, "USDC");
    assert.equal(deposit.evidenceTier, "PROVEN");
    assert.equal(deposit.evidenceDetail, "stellar_ledger");
    assert.equal(deposit.keystoneRef, null);

    const withdrawal = events.find((e) => e.onchainRef === "h1");
    assert.ok(withdrawal);
    assert.equal(withdrawal.direction, "withdrawal");
    assert.equal(withdrawal.asset, "XLM");
  } finally {
    server.close();
  }
});

test("scan() respects minAmount", async () => {
  const { server, base } = await mockHorizon();
  try {
    const adapter = new StellarAdapter({ horizon: base });
    const events: SettlementEvent[] = [];
    for await (const ev of adapter.scan(ANCHOR, { minAmount: "50" })) events.push(ev);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.onchainRef, "h2");
  } finally {
    server.close();
  }
});

test("scan() throws rather than silently ignoring an unsupported ledger-range filter", async () => {
  const { server, base } = await mockHorizon();
  try {
    const adapter = new StellarAdapter({ horizon: base });
    await assert.rejects(async () => {
      for await (const _ of adapter.scan(ANCHOR, { fromLedgerOrBlock: 12345 })) {
        // unreachable
      }
    });
  } finally {
    server.close();
  }
});

test("verify() confirms a successful transaction independently against Horizon", async () => {
  const { server, base } = await mockHorizon();
  try {
    const adapter = new StellarAdapter({ horizon: base });
    const ok: SettlementEvent = {
      anchorId: ANCHOR,
      chain: "stellar",
      asset: "USDC",
      direction: "deposit",
      amount: "100",
      onchainRef: "h2",
      evidenceTier: "PROVEN",
      evidenceDetail: "stellar_ledger",
      observedAt: "2026-03-01T06:00:00Z",
    };
    assert.equal(await adapter.verify(ok), true);
  } finally {
    server.close();
  }
});

test("verify() returns false for a failed transaction, an unknown hash, or the wrong chain", async () => {
  const { server, base } = await mockHorizon();
  try {
    const adapter = new StellarAdapter({ horizon: base });
    const base_: SettlementEvent = {
      anchorId: ANCHOR,
      chain: "stellar",
      asset: "USDC",
      direction: "deposit",
      amount: "100",
      onchainRef: "hbad",
      evidenceTier: "PROVEN",
      evidenceDetail: "stellar_ledger",
      observedAt: "2026-03-01T06:00:00Z",
    };
    assert.equal(await adapter.verify(base_), false);
    assert.equal(await adapter.verify({ ...base_, onchainRef: "hmissing" }), false);
    assert.equal(await adapter.verify({ ...base_, onchainRef: "h2", chain: "ethereum" }), false);
  } finally {
    server.close();
  }
});
