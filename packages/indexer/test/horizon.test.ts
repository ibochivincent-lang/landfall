import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { fetchPayments } from "../src/horizon.js";
import { computeMetrics } from "../src/metrics.js";
import { DEFAULT_SCAN_OPTIONS, type AnchorAccount } from "../src/types.js";

const ANCHOR = "GANCHOR";
const USER = "GUSER";

/**
 * A stand-in Horizon that paginates like the real one: two pages linked by
 * _links.next.href, records newest-first. This exercises cursor following,
 * the maxRecords cap and the `since` boundary without touching the network.
 */
function mockHorizon(): Promise<{ server: Server; base: string }> {
  const page1 = {
    _links: { next: { href: "PLACEHOLDER/page2" } },
    _embedded: {
      records: [
        {
          type: "payment",
          paging_token: "300",
          transaction_hash: "h3",
          from: ANCHOR,
          to: USER,
          amount: "100.0000000",
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: "GISSUER",
          created_at: "2026-03-01T12:00:00Z",
        },
        {
          type: "change_trust", // must be skipped by normalise
          paging_token: "250",
          transaction_hash: "h2b",
          created_at: "2026-03-01T11:00:00Z",
        },
      ],
    },
  };

  const page2 = {
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
          from: USER,
          to: ANCHOR,
          amount: "50.0000000",
          asset_type: "native",
          created_at: "2025-01-01T00:00:00Z", // old — excluded by --since
        },
      ],
    },
  };

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/page2")) {
        res.end(JSON.stringify(page2));
      } else {
        res.end(JSON.stringify(page1).replace("PLACEHOLDER", base));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ server, base });
    });
  });
}

test("fetchPayments follows pagination, skips non-transfers, and feeds metrics", async () => {
  const { server, base } = await mockHorizon();
  try {
    const { records, newestCursor } = await fetchPayments({
      horizon: base,
      account: ANCHOR,
      maxRecords: 100,
      since: "2026-01-01T00:00:00Z",
    });

    // h3, h2 kept. change_trust dropped by normalise. h1 excluded by `since`.
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => r.txHash),
      ["h3", "h2"],
    );
    assert.equal(newestCursor, "300");
    assert.equal(records[0]?.asset, "USDC:GISSUER");

    const anchor: AnchorAccount = { domain: "mock.test", account: ANCHOR, role: "declared" };
    const m = computeMetrics(anchor, records, DEFAULT_SCAN_OPTIONS, new Date("2026-03-02T12:00:00Z"));

    // 100 in at 06:00, 100 back out at 12:00 — a clean return.
    assert.equal(m.inbound.count, 1);
    assert.equal(m.outbound.count, 1);
    assert.equal(m.refundCount, 1);
    assert.equal(m.refundRate, 1);
    assert.equal(m.medianRefundLatencyHours, 6);
    assert.equal(m.hoursSinceLastActivity, 24);
  } finally {
    server.close();
  }
});

test("fetchPayments honours the maxRecords cap", async () => {
  const { server, base } = await mockHorizon();
  try {
    const { records } = await fetchPayments({ horizon: base, account: ANCHOR, maxRecords: 1 });
    assert.equal(records.length, 1);
  } finally {
    server.close();
  }
});
