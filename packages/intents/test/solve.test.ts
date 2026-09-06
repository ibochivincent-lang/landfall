import assert from "node:assert/strict";
import { test } from "node:test";

import { solveIntent } from "../src/solve.js";
import type { Intent, RouteCandidate } from "../src/types.js";

const cowrie: RouteCandidate = {
  domain: "cowrie.exchange", name: "Cowrie", rateSpread: 0.998,
  feePercent: 0.8, feeFixed: 0.5, feeSource: "catalog", grade: "D", score: 44,
};
const mykobo: RouteCandidate = {
  domain: "mykobo.co", name: "MyKobo", rateSpread: 0.992,
  feePercent: 1, feeFixed: 0, feeSource: "live", grade: "C", score: 62,
};
const unpricedAnchor: RouteCandidate = {
  domain: "quiet.example", name: "Quiet", rateSpread: 1,
  feePercent: 0, feeFixed: 0, feeSource: null, grade: "B", score: 71,
};

const MID = 1610.5;

test("send basis reproduces the forward quote", () => {
  const intent: Intent = { from: "USDC", to: "NGN", basis: "send", amount: 100 };
  const { solutions } = solveIntent(intent, [cowrie], MID);
  const s = solutions[0]!;
  // rate 1610.5 × 0.998 = 1607.279 → 1607.279; fee 100×0.008 + 0.5 = 1.30
  assert.equal(s.rate, 1607.279);
  assert.equal(s.fee, 1.3);
  assert.equal(s.receive, Math.round(98.7 * 1607.279 * 100) / 100);
});

test("receive basis is the exact inverse of send basis", () => {
  // Solve for a target, then feed the resulting send amount forward and
  // confirm it lands back on the target. This is the property that matters:
  // "pay ₦500k" has to actually pay ₦500k.
  const target = 500_000;
  const reverse = solveIntent({ from: "USDC", to: "NGN", basis: "receive", amount: target }, [mykobo], MID);
  const send = reverse.solutions[0]!.send!;

  const forward = solveIntent({ from: "USDC", to: "NGN", basis: "send", amount: send }, [mykobo], MID);
  const landed = forward.solutions[0]!.receive!;

  // Never under. The send side is priced in cents, so an exact hit is not
  // generally available — but the direction of the miss is a choice, and
  // under-delivering a stated target is the one that breaks the promise.
  assert.ok(landed >= target, `round-trip landed on ${landed}, under the ${target} target`);

  // And never meaningfully over: one cent of send at this rate is about ₦16,
  // so anything beyond that is an arithmetic error rather than rounding.
  const oneCentAtRate = forward.solutions[0]!.rate! / 100;
  assert.ok(
    landed - target <= oneCentAtRate,
    `round-trip overshot by ${landed - target}, more than one cent (~${oneCentAtRate})`,
  );
});

test("receive basis ranks by least sent, not most received", () => {
  const intent: Intent = { from: "USDC", to: "NGN", basis: "receive", amount: 500_000 };
  const { solutions } = solveIntent(intent, [cowrie, mykobo], MID);
  // Every anchor delivers exactly the target, so payout cannot rank them.
  assert.ok(solutions.every((s) => s.receive === 500_000));
  assert.ok(solutions[0]!.send! <= solutions[1]!.send!, "cheapest send must come first");
});

test("send basis ranks by most received", () => {
  const intent: Intent = { from: "USDC", to: "NGN", basis: "send", amount: 100 };
  const { solutions } = solveIntent(intent, [mykobo, cowrie], MID);
  assert.ok(solutions[0]!.receive! >= solutions[1]!.receive!);
});

test("a fee at or above 100% makes a receive-first target unreachable, not merely expensive", () => {
  const gouger: RouteCandidate = { ...mykobo, domain: "gouge.example", feePercent: 100 };
  const { solutions, rejected, unsatisfiable } = solveIntent(
    { from: "USDC", to: "NGN", basis: "receive", amount: 500_000 },
    [gouger],
    MID,
  );
  assert.equal(solutions.length, 0);
  assert.equal(rejected[0]!.rejected, "fee-exceeds-principal");
  assert.equal(unsatisfiable, true);
});

test("a fixed fee larger than the principal rejects the route rather than quoting a zero payout", () => {
  const steep: RouteCandidate = { ...cowrie, domain: "steep.example", feeFixed: 25 };
  const { solutions, rejected } = solveIntent(
    { from: "USDC", to: "NGN", basis: "send", amount: 10 },
    [steep],
    MID,
  );
  assert.equal(solutions.length, 0);
  assert.equal(rejected[0]!.rejected, "fee-exceeds-principal");
});

test("unpriced anchors are listed but never counted as a working route", () => {
  const { solutions, unsatisfiable } = solveIntent(
    { from: "USDC", to: "NGN", basis: "send", amount: 100 },
    [unpricedAnchor],
    MID,
  );
  assert.equal(solutions.length, 1);
  assert.equal(solutions[0]!.priced, false);
  assert.equal(solutions[0]!.receive, null, "an unpriced route must not carry an invented payout");
  assert.equal(unsatisfiable, true, "listing is not satisfying");
});

test("requirePricedTerms moves unpriced anchors into rejected with a reason", () => {
  const { solutions, rejected } = solveIntent(
    { from: "USDC", to: "NGN", basis: "send", amount: 100, requirePricedTerms: true },
    [unpricedAnchor],
    MID,
  );
  assert.equal(solutions.length, 0);
  assert.equal(rejected[0]!.rejected, "unpriced");
});

test("a grade floor rejects below it and keeps the reason", () => {
  const { solutions, rejected } = solveIntent(
    { from: "USDC", to: "NGN", basis: "send", amount: 100, minGrade: "C" },
    [cowrie, mykobo],
    MID,
  );
  assert.deepEqual(solutions.map((s) => s.domain), ["mykobo.co"]);
  assert.equal(rejected[0]!.domain, "cowrie.exchange");
  assert.equal(rejected[0]!.rejected, "below-grade-floor");
});

test("no candidates at all is unsatisfiable, not an empty success", () => {
  const r = solveIntent({ from: "USDC", to: "NGN", basis: "receive", amount: 1 }, [], MID);
  assert.equal(r.unsatisfiable, true);
  assert.equal(r.solutions.length, 0);
});

test("ties break on domain so the ranking is deterministic", () => {
  const a: RouteCandidate = { ...mykobo, domain: "b.example" };
  const b: RouteCandidate = { ...mykobo, domain: "a.example" };
  const r = solveIntent({ from: "USDC", to: "NGN", basis: "send", amount: 100 }, [a, b], MID);
  assert.deepEqual(r.solutions.map((s) => s.domain), ["a.example", "b.example"]);
});

/* ── sortBy: "verified" ──────────────────────────────────────────────────
   The worked example this ranking exists for: the cheapest, best-rate route
   is the least reliable one, and a route ranked by evidence should say so
   by NOT putting it first — the opposite of what sortBy: "payout" (the
   default) would do with the same three routes. */

const routeA: RouteCandidate = {
  domain: "route-a.example", name: "Route A", rateSpread: 1, feePercent: 0.5, feeFixed: 0,
  feeSource: "live", grade: "A", score: 94, liquidityTier: "high", recentPayments: 500,
};
const routeB: RouteCandidate = {
  domain: "route-b.example", name: "Route B", rateSpread: 1.003, feePercent: 0.2, feeFixed: 0,
  feeSource: "live", grade: "C", score: 58, liquidityTier: "medium", recentPayments: 40,
};
const routeC: RouteCandidate = {
  domain: "route-c.example", name: "Route C", rateSpread: 1.007, feePercent: 0.1, feeFixed: 0,
  feeSource: "live", grade: "D", score: 31, liquidityTier: "low", recentPayments: 3,
};

test("sortBy 'payout' (the default) picks the cheapest route regardless of evidence", () => {
  const { solutions } = solveIntent({ from: "USDC", to: "NGN", basis: "send", amount: 1000 }, [routeA, routeB, routeC], MID);
  // C has the best rate and lowest fee, so plain payout ranking puts it first.
  assert.equal(solutions[0]!.domain, "route-c.example");
});

test("sortBy 'verified' ranks grade and liquidity ahead of price, inverting the payout order", () => {
  const { solutions } = solveIntent(
    { from: "USDC", to: "NGN", basis: "send", amount: 1000, sortBy: "verified" },
    [routeA, routeB, routeC],
    MID,
  );
  assert.deepEqual(
    solutions.map((s) => s.domain),
    ["route-a.example", "route-b.example", "route-c.example"],
    "A (grade A, high liquidity) must outrank B and C despite the worse rate and fee",
  );
});

test("sortBy 'verified' still breaks a grade+liquidity tie on amount, not by giving up", () => {
  const twinA: RouteCandidate = { ...routeA, domain: "twin-a.example", feePercent: 2 }; // pricier
  const twinB: RouteCandidate = { ...routeA, domain: "twin-b.example" };                // same grade+liquidity, cheaper
  const { solutions } = solveIntent(
    { from: "USDC", to: "NGN", basis: "send", amount: 1000, sortBy: "verified" },
    [twinA, twinB],
    MID,
  );
  assert.equal(solutions[0]!.domain, "twin-b.example", "identical evidence must fall back to amount, not domain order");
});

test("sortBy 'verified' never blends grade and liquidity into one number — grade always decides first", () => {
  // Deliberately adversarial: lower-liquidity route has the better grade.
  // If these were multiplied into a single score, a large-enough liquidity
  // gap could out-vote a grade difference. It must not be able to.
  const highGradeLowLiquidity: RouteCandidate = {
    domain: "hg-ll.example", name: "HG-LL", rateSpread: 1, feePercent: 0, feeFixed: 0,
    feeSource: "live", grade: "B", score: 80, liquidityTier: "low", recentPayments: 2,
  };
  const lowGradeHighLiquidity: RouteCandidate = {
    domain: "lg-hl.example", name: "LG-HL", rateSpread: 1, feePercent: 0, feeFixed: 0,
    feeSource: "live", grade: "D", score: 30, liquidityTier: "high", recentPayments: 900,
  };
  const { solutions } = solveIntent(
    { from: "USDC", to: "NGN", basis: "send", amount: 1000, sortBy: "verified" },
    [lowGradeHighLiquidity, highGradeLowLiquidity],
    MID,
  );
  assert.equal(solutions[0]!.domain, "hg-ll.example", "grade must win outright, no amount of liquidity should compensate for a worse grade");
});

test("an omitted liquidityTier defaults to 'unknown', not 'low' — silence is not a claim of illiquidity", () => {
  const noLiquidityData: RouteCandidate = { ...routeB, domain: "no-data.example", liquidityTier: undefined, recentPayments: undefined };
  const { solutions } = solveIntent({ from: "USDC", to: "NGN", basis: "send", amount: 100 }, [noLiquidityData], MID);
  assert.equal(solutions[0]!.liquidityTier, "unknown");
  assert.equal(solutions[0]!.recentPayments, null);
});
