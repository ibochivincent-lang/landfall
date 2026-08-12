import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyLiveness,
  bucketCounts,
  renderHeadline,
  renderTable,
  LIVE_MAX_HOURS,
  DARK_MIN_HOURS,
} from "../src/report.js";
import type { AccountMetrics } from "../src/types.js";

function metrics(over: Partial<AccountMetrics> & { account: string; domain: string }): AccountMetrics {
  return {
    sampled: 100,
    hasLifetimeActivity: true,
    dustExcluded: 0,
    inbound: { count: 100, uniqueCounterparties: 50, byAsset: [] },
    outbound: { count: 50, uniqueCounterparties: 25, byAsset: [] },
    refundCount: 0,
    refundRate: 0,
    medianRefundLatencyHours: null,
    refunds: [],
    topCounterpartyShare: null,
    hoursSinceLastActivity: 1,
    ...over,
  };
}

test("classifyLiveness puts accounts in the right bucket at the boundaries", () => {
  assert.equal(
    classifyLiveness(metrics({ account: "G1", domain: "a.com", hoursSinceLastActivity: 47.9 })),
    "live",
  );
  assert.equal(
    classifyLiveness(
      metrics({ account: "G2", domain: "a.com", hoursSinceLastActivity: LIVE_MAX_HOURS }),
    ),
    "slow",
  );
  assert.equal(
    classifyLiveness(
      metrics({ account: "G3", domain: "a.com", hoursSinceLastActivity: DARK_MIN_HOURS }),
    ),
    "dark",
  );
});

test("classifyLiveness treats an account with no records as no-activity, not dark", () => {
  // An issuer account with no payments has not "gone dark" — it never moved.
  // Conflating the two would manufacture a finding out of normal structure.
  const m = metrics({
    account: "G4",
    domain: "a.com",
    sampled: 0,
    hasLifetimeActivity: false,
    hoursSinceLastActivity: undefined,
    inbound: { count: 0, uniqueCounterparties: 0, byAsset: [] },
    outbound: { count: 0, uniqueCounterparties: 0, byAsset: [] },
    refundRate: null,
  });
  assert.equal(classifyLiveness(m), "no-activity");
});

test("bucketCounts partitions every account exactly once", () => {
  const all = [
    metrics({ account: "G1", domain: "a.com", hoursSinceLastActivity: 2 }),
    metrics({ account: "G2", domain: "a.com", hoursSinceLastActivity: 200 }),
    metrics({ account: "G3", domain: "b.com", hoursSinceLastActivity: 5000 }),
    metrics({ account: "G4", domain: "b.com", sampled: 0, hasLifetimeActivity: false, hoursSinceLastActivity: undefined }),
  ];
  const b = bucketCounts(all);
  assert.equal(b.live.length, 1);
  assert.equal(b.slow.length, 1);
  assert.equal(b.dark.length, 1);
  assert.equal(b["no-activity"].length, 1);
  assert.equal(
    b.live.length + b.slow.length + b.dark.length + b["no-activity"].length,
    all.length,
  );
});

test("headline leads with the dark-account census", () => {
  const all = [
    metrics({ account: "G1", domain: "live.com", hoursSinceLastActivity: 2 }),
    metrics({ account: "G2", domain: "dark.com", hoursSinceLastActivity: 5000 }),
  ];
  const text = renderHeadline(all);
  assert.match(text, /Of 2 anchor accounts across 2 domains, 1 has processed no on-chain settlement in over 30 days/);
});

test("headline names a domain whose every active account is dark", () => {
  const all = [
    metrics({ account: "G1", domain: "gone.com", hoursSinceLastActivity: 5000 }),
    metrics({ account: "G2", domain: "gone.com", hoursSinceLastActivity: 6000 }),
    metrics({ account: "G3", domain: "fine.com", hoursSinceLastActivity: 3 }),
  ];
  const text = renderHeadline(all);
  assert.match(text, /Every account with payment history at gone\.com is dark/);
  assert.doesNotMatch(text, /fine\.com is dark/);
});

test("a domain with a dark account but also a live one is not called fully dark", () => {
  const all = [
    metrics({ account: "G1", domain: "mixed.com", hoursSinceLastActivity: 5000 }),
    metrics({ account: "G2", domain: "mixed.com", hoursSinceLastActivity: 3 }),
  ];
  assert.doesNotMatch(renderHeadline(all), /Every account with payment history/);
});

test("an issuer-only account does not make a domain look fully dark", () => {
  const all = [
    metrics({ account: "G1", domain: "issuer.com", hoursSinceLastActivity: 3 }),
    metrics({ account: "G2", domain: "issuer.com", sampled: 0, hasLifetimeActivity: false, hoursSinceLastActivity: undefined }),
  ];
  assert.doesNotMatch(renderHeadline(all), /Every account with payment history/);
});

test("headline flags a small refund sample rather than presenting it as a rate", () => {
  const all = [
    metrics({
      account: "G1",
      domain: "a.com",
      inbound: { count: 745, uniqueCounterparties: 300, byAsset: [] },
      refundCount: 3,
      refundRate: 0.004,
      refunds: [
        { counterparty: "GX", asset: "USDC", inAmount: "1", outAmount: "1", inAt: "", outAt: "", latencyHours: 240, inTxHash: "a", outTxHash: "b" },
        { counterparty: "GY", asset: "USDC", inAmount: "1", outAmount: "1", inAt: "", outAt: "", latencyHours: 280, inTxHash: "c", outTxHash: "d" },
        { counterparty: "GZ", asset: "USDC", inAmount: "1", outAmount: "1", inAt: "", outAt: "", latencyHours: 300, inTxHash: "e", outTxHash: "f" },
      ],
    }),
  ];
  const text = renderHeadline(all, 50);
  assert.match(text, /n=3/);
  assert.match(text, /not a property of the anchor/);
});

test("headline always states the invisible-failure limitation", () => {
  const text = renderHeadline([metrics({ account: "G1", domain: "a.com" })]);
  assert.match(text, /neither settles nor returns it produces no signal/);
  assert.match(text, /A low return rate is not evidence of good conduct/);
});

test("headline handles an empty scan without throwing", () => {
  assert.equal(renderHeadline([]), "No accounts scanned.");
});

test("table sorts dark accounts above live ones", () => {
  const all = [
    metrics({ account: "GLIVEAAAA", domain: "live.com", hoursSinceLastActivity: 2 }),
    metrics({ account: "GDARKBBBB", domain: "dark.com", hoursSinceLastActivity: 5000 }),
  ];
  const lines = renderTable(all).split("\n");
  const darkRow = lines.findIndex((l) => l.includes("dark.com"));
  const liveRow = lines.findIndex((l) => l.includes("live.com"));
  assert.ok(darkRow < liveRow, "dark accounts should be listed first");
  assert.match(lines[darkRow] as string, /DARK/);
});
