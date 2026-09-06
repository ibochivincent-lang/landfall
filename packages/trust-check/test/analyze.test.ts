import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeTrustCheck } from "../src/analyze.js";
import type { ObservedPayment, TrustCheckInput } from "../src/types.js";

const ADDR = "GADDRESS0000000000000000000000000000000000000000000000";
const OTHER = "GOTHER00000000000000000000000000000000000000000000000";
const OTHER2 = "GOTHER20000000000000000000000000000000000000000000000";

function pay(overrides: Partial<ObservedPayment>): ObservedPayment {
  return {
    txHash: "tx" + Math.random().toString(36).slice(2),
    from: OTHER,
    to: ADDR,
    amount: "100",
    asset: "native",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function input(overrides: Partial<TrustCheckInput>): TrustCheckInput {
  return {
    address: ADDR,
    oldestRetainedPaymentAt: "2025-01-01T00:00:00Z",
    recentPayments: [],
    recentPaymentsTruncated: false,
    checkedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("no payment history at all: unknown risk, no flags, says so plainly", () => {
  const r = analyzeTrustCheck(input({ oldestRetainedPaymentAt: null, recentPayments: [] }));
  assert.equal(r.paymentCount, 0);
  assert.equal(r.age.observedDays, null);
  assert.equal(r.riskLevel, "unknown");
  assert.equal(r.confidence, "low");
  assert.equal(r.flags.length, 0);
  assert.match(r.recommendation, /No observed payment history/);
});

test("age is reported as days between oldest retained payment and checkedAt", () => {
  const r = analyzeTrustCheck(input({
    oldestRetainedPaymentAt: "2026-01-01T00:00:00Z",
    checkedAt: "2026-01-11T00:00:00Z",
  }));
  assert.equal(r.age.observedDays, 10);
  assert.equal(r.age.isLowerBoundOnly, true);
});

test("a handful of payments is low confidence regardless of what the score says", () => {
  const payments = [pay({}), pay({}), pay({})];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  assert.equal(r.confidence, "low");
  assert.equal(r.riskLevel, "unknown", "low confidence must override the score-derived level");
});

test("25+ clean payments over a long history: low risk, high confidence", () => {
  const payments = Array.from({ length: 25 }, (_, i) => pay({ from: `GCOUNTERPARTY${i}00000000000000000000000000000000000000` }));
  const r = analyzeTrustCheck(input({
    oldestRetainedPaymentAt: "2020-01-01T00:00:00Z",
    recentPayments: payments,
  }));
  assert.equal(r.confidence, "high");
  assert.equal(r.riskScore, 100);
  assert.equal(r.riskLevel, "low");
  assert.equal(r.flags.length, 0);
});

test("new-with-high-volume fires under 7 days with 10+ payments, not at the boundary", () => {
  const tenPayments = Array.from({ length: 10 }, () => pay({}));
  const under = analyzeTrustCheck(input({
    oldestRetainedPaymentAt: "2025-12-30T00:00:00Z", // 2 days before checkedAt
    recentPayments: tenPayments,
  }));
  assert.ok(under.flags.some((f) => f.id === "new-with-high-volume"));

  const over = analyzeTrustCheck(input({
    oldestRetainedPaymentAt: "2025-01-01T00:00:00Z", // long history
    recentPayments: tenPayments,
  }));
  assert.ok(!over.flags.some((f) => f.id === "new-with-high-volume"));
});

test("new-with-high-volume needs volume too — a quiet new account is not flagged", () => {
  const r = analyzeTrustCheck(input({
    oldestRetainedPaymentAt: "2025-12-31T00:00:00Z",
    recentPayments: [pay({}), pay({})],
  }));
  assert.ok(!r.flags.some((f) => f.id === "new-with-high-volume"));
});

test("pass-through pattern: inbound followed by a same-asset outbound within the window", () => {
  const payments: ObservedPayment[] = [
    pay({ txHash: "in1", from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:00:00Z" }),
    pay({ txHash: "out1", from: ADDR, to: OTHER2, amount: "98", createdAt: "2026-01-01T00:05:00Z" }),
    pay({ txHash: "in2", from: OTHER, to: ADDR, amount: "200", createdAt: "2026-01-02T00:00:00Z" }),
    pay({ txHash: "out2", from: ADDR, to: OTHER2, amount: "199", createdAt: "2026-01-02T00:03:00Z" }),
    pay({ txHash: "in3", from: OTHER, to: ADDR, amount: "50", createdAt: "2026-01-03T00:00:00Z" }),
    pay({ txHash: "out3", from: ADDR, to: OTHER2, amount: "49", createdAt: "2026-01-03T00:02:00Z" }),
  ];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  const flag = r.flags.find((f) => f.id === "pass-through-pattern");
  assert.ok(flag, "expected the pass-through flag to fire");
  assert.equal(r.forwarding.fastForwardedCount, 3);
  assert.equal(flag!.severity, "high");
});

test("a forward outside the time window does not count", () => {
  const payments: ObservedPayment[] = [
    pay({ from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:00:00Z" }),
    pay({ from: ADDR, to: OTHER2, amount: "99", createdAt: "2026-01-01T01:00:00Z" }), // 1h later, window is 10m
    ...Array.from({ length: 3 }, () => pay({ from: OTHER, to: ADDR })),
  ];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  assert.equal(r.forwarding.fastForwardedCount, 0);
});

test("a partial forward below the match fraction does not count", () => {
  const payments: ObservedPayment[] = [
    pay({ from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:00:00Z" }),
    pay({ from: ADDR, to: OTHER2, amount: "50", createdAt: "2026-01-01T00:01:00Z" }), // only half forwarded
  ];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  assert.equal(r.forwarding.fastForwardedCount, 0);
});

test("one outbound payment cannot satisfy two inbound matches", () => {
  const payments: ObservedPayment[] = [
    pay({ from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:00:00Z" }),
    pay({ from: OTHER2, to: ADDR, amount: "100", createdAt: "2026-01-01T00:00:30Z" }),
    pay({ from: ADDR, to: OTHER2, amount: "100", createdAt: "2026-01-01T00:01:00Z" }), // one outbound only
  ];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  assert.equal(r.forwarding.fastForwardedCount, 1, "only one inbound should be able to claim the single outbound");
});

test("returning funds to the same counterparty (a refund) is not counted as forwarding", () => {
  const payments: ObservedPayment[] = [
    pay({ from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:00:00Z" }),
    pay({ from: ADDR, to: OTHER, amount: "99", createdAt: "2026-01-01T00:01:00Z" }), // back to same sender
  ];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  assert.equal(r.forwarding.fastForwardedCount, 0);
});

test("high concentration flag fires at 80%+ with enough payments, and is informational severity", () => {
  const payments = [
    ...Array.from({ length: 8 }, () => pay({ from: OTHER, amount: "100" })),
    pay({ from: OTHER2, amount: "50" }),
  ];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  const flag = r.flags.find((f) => f.id === "high-concentration");
  assert.ok(flag);
  assert.equal(flag!.severity, "info");
  assert.equal(r.concentration.topCounterparty, OTHER);
});

test("concentration never mixes two different assets into one blended share", () => {
  const payments = [
    pay({ from: OTHER, amount: "1000000", asset: "native" }),
    pay({ from: OTHER2, amount: "1", asset: "USDC:GISSUER" }),
  ];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  // OTHER dominates native (100%); OTHER2 is 100% of the (tiny) USDC volume.
  // The reported "best" share must be one counterparty's real per-asset share, not a cross-asset average.
  assert.equal(r.concentration.topCounterpartyShare, 1);
});

test("self-payments are excluded from the counterparty signal", () => {
  const payments = [pay({ from: ADDR, to: ADDR, amount: "100" }), pay({ from: OTHER, to: ADDR })];
  const r = analyzeTrustCheck(input({ recentPayments: payments }));
  assert.equal(r.concentration.distinctCounterparties, 1);
});

test("riskScore deducts exactly the documented amount per flag severity, never more", () => {
  // Construct a case with exactly one "high" flag (pass-through) and nothing else.
  const payments: ObservedPayment[] = [
    ...Array.from({ length: 20 }, (_, i) => pay({ from: `GC${i}0000000000000000000000000000000000000000000000` })), // dilutes concentration below 80%
    pay({ txHash: "in", from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:00:00Z" }),
    pay({ txHash: "out", from: ADDR, to: OTHER2, amount: "100", createdAt: "2026-01-01T00:01:00Z" }),
    pay({ txHash: "in2", from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-02T00:00:00Z" }),
    pay({ txHash: "out2", from: ADDR, to: OTHER2, amount: "100", createdAt: "2026-01-02T00:01:00Z" }),
    pay({ txHash: "in3", from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-03T00:00:00Z" }),
    pay({ txHash: "out3", from: ADDR, to: OTHER2, amount: "100", createdAt: "2026-01-03T00:01:00Z" }),
  ];
  const r = analyzeTrustCheck(input({
    oldestRetainedPaymentAt: "2020-01-01T00:00:00Z",
    recentPayments: payments,
  }));
  const highFlags = r.flags.filter((f) => f.severity === "high").length;
  const warningFlags = r.flags.filter((f) => f.severity === "warning").length;
  const infoFlags = r.flags.filter((f) => f.severity === "info").length;
  assert.equal(r.riskScore, 100 - highFlags * 30 - warningFlags * 15 - infoFlags * 0);
});

test("multiple simultaneous flags stack their deductions rather than overriding one another", () => {
  // Force every flag to fire at once: young + high volume, full pass-through
  // (every inbound forwarded, keeping the fraction at 100% rather than
  // diluting it with unrelated inbound payments), and high concentration
  // (all inbound from the same counterparty). The current flag set can
  // deduct at most 45 (one high + one warning + one info), so this can't
  // reach the riskScore floor of 0 — that clamp exists for whatever gets
  // added to buildFlags() next, not because today's flags can trigger it.
  const payments: ObservedPayment[] = [];
  for (let i = 0; i < 5; i++) {
    const at = `2026-01-01T00:0${i}:00Z`;
    payments.push(pay({ txHash: `in${i}`, from: OTHER, to: ADDR, amount: "100", createdAt: at }));
    payments.push(pay({ txHash: `out${i}`, from: ADDR, to: OTHER2, amount: "99", createdAt: `2026-01-01T00:0${i}:30Z` }));
  }
  const r = analyzeTrustCheck(input({
    oldestRetainedPaymentAt: "2025-12-31T00:00:00Z",
    recentPayments: payments,
  }));
  assert.ok(r.riskScore >= 0);
  // high (-30) + warning (-15) + info (-0) = 45 off a base of 100 -> 55,
  // which is "medium" under the documented thresholds (< 40 is "high").
  // Reaching an actual "high" level needs two "high"-severity flags, not
  // this test's point — the assertion that matters here is the floor.
  assert.equal(r.riskScore, 55);
  assert.equal(r.riskLevel, "medium");
});

test("limits text distinguishes a truncated fetch from a complete one", () => {
  const complete = analyzeTrustCheck(input({ recentPayments: [pay({})], recentPaymentsTruncated: false }));
  const truncated = analyzeTrustCheck(input({ recentPayments: [pay({})], recentPaymentsTruncated: true }));
  assert.match(complete.limits, /All 1 payment record/);
  assert.match(truncated.limits, /more payment history than the 1 most recent/);
});
