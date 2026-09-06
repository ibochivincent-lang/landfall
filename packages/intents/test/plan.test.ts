import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPlan } from "../src/plan.js";
import { solveIntent } from "../src/solve.js";
import type { RouteCandidate, Solution } from "../src/types.js";

const MID = 1610.5;

const goodAnchor: RouteCandidate = {
  domain: "good.example", name: "Good Anchor", rateSpread: 0.998,
  feePercent: 0.5, feeFixed: 0, feeSource: "live", grade: "A", score: 94,
  liquidityTier: "high", recentPayments: 400,
};
const weakAnchor: RouteCandidate = {
  domain: "weak.example", name: "Weak Anchor", rateSpread: 0.998,
  feePercent: 0.5, feeFixed: 0, feeSource: "live", grade: "D", score: 31,
  liquidityTier: "low", recentPayments: 3,
};

function solutionFor(candidate: RouteCandidate): Solution {
  const { solutions } = solveIntent(
    { from: "USDC", to: "NGN", basis: "send", amount: 1000 },
    [candidate],
    MID,
  );
  return solutions[0]!;
}

test("a plan orders its steps and never assigns a value-moving step to Landfall", () => {
  const plan = buildPlan({ solution: solutionFor(goodAnchor), from: "USDC", to: "NGN" });

  assert.deepEqual(plan.steps.map((s) => s.order), [1, 2, 3, 4, 5, 6]);

  const landfallSteps = plan.steps.filter((s) => s.actor === "landfall");
  assert.equal(landfallSteps.length, 1, "only the read-only check should be Landfall's");
  assert.equal(landfallSteps[0]!.id, "verify-counterparty");

  // The step that actually sends money must belong to the wallet, never to us.
  const send = plan.steps.find((s) => s.id === "send-payment")!;
  assert.equal(send.actor, "wallet");
});

test("the plan always ends by asking whether the money actually arrived", () => {
  const plan = buildPlan({ solution: solutionFor(goodAnchor), from: "USDC", to: "NGN" });
  const last = plan.steps[plan.steps.length - 1]!;
  assert.equal(last.id, "confirm-receipt");
  assert.equal(last.endpoint, "/api/v1/fiat-confirmations");
});

test("plan carries the solved amounts through rather than recomputing them", () => {
  const solution = solutionFor(goodAnchor);
  const plan = buildPlan({ solution, from: "USDC", to: "NGN" });
  assert.equal(plan.send, solution.send);
  assert.equal(plan.receive, solution.receive);
});

test("a weak-evidence route attaches a caution that is about evidence, not about the operator", () => {
  const plan = buildPlan({ solution: solutionFor(weakAnchor), from: "USDC", to: "NGN" });
  assert.ok(plan.caution, "expected a caution for a D-graded route");
  assert.match(plan.caution!, /not an allegation about the operator/);
});

test("a strong route carries no caution", () => {
  const plan = buildPlan({ solution: solutionFor(goodAnchor), from: "USDC", to: "NGN" });
  assert.equal(plan.caution, null);
});

test("an untracked (U) route is cautioned too — no evidence is not the same as good evidence", () => {
  const untracked: RouteCandidate = { ...goodAnchor, domain: "u.example", grade: "U", score: null };
  const plan = buildPlan({ solution: solutionFor(untracked), from: "USDC", to: "NGN" });
  assert.ok(plan.caution);
  assert.match(plan.caution!, /untracked/);
});

test("every plan restates that Landfall does not execute", () => {
  const plan = buildPlan({ solution: solutionFor(goodAnchor), from: "USDC", to: "NGN" });
  assert.match(plan.executionNote, /holds no keys/);
  assert.match(plan.executionNote, /plan, not an execution/);
});

test("the anchor's own URL is used when supplied, and its absence is handled without a broken sentence", () => {
  const withUrl = buildPlan({
    solution: solutionFor(goodAnchor), from: "USDC", to: "NGN",
    anchorUrl: "https://good.example/offramp",
  });
  assert.match(withUrl.steps.find((s) => s.id === "open-anchor-flow")!.detail, /https:\/\/good\.example\/offramp/);

  const withoutUrl = buildPlan({ solution: solutionFor(goodAnchor), from: "USDC", to: "NGN" });
  const detail = withoutUrl.steps.find((s) => s.id === "open-anchor-flow")!.detail;
  assert.ok(!detail.includes("undefined"), "a missing URL must not leak 'undefined' into the plan");
});

test("the trustline step is marked conditional — it is not always required", () => {
  const plan = buildPlan({ solution: solutionFor(goodAnchor), from: "USDC", to: "NGN" });
  assert.equal(plan.steps.find((s) => s.id === "establish-trustline")!.conditional, true);
});
