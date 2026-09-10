/**
 * packages/stp/test/slippage.test.ts
 *
 * Tests for the Slippage Intelligence Engine (Quoted vs. Landed).
 * Author: ibochivincent-lang
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSlippage,
  aggregateAnchorSlippage,
  type SlippageObservation,
} from "../src/slippage.js";

test("computeSlippage calculates exact zero slippage when landed equals quoted", () => {
  const res = computeSlippage({
    domain: "test.example",
    assetIn: "USDC",
    assetOut: "NGN",
    quotedAmount: 1000,
    landedAmount: 1000,
  });

  assert.equal(res.deltaAmount, 0);
  assert.equal(res.slippageBps, 0);
  assert.equal(res.slippagePercent, 0);
  assert.equal(res.favorable, true);
});

test("computeSlippage calculates positive slippage bps when payout is degraded", () => {
  const res = computeSlippage({
    domain: "test.example",
    assetIn: "USDC",
    assetOut: "NGN",
    quotedAmount: 1000,
    landedAmount: 990, // 1% gap
  });

  assert.equal(res.deltaAmount, 10);
  assert.equal(res.slippageBps, 100);
  assert.equal(res.slippagePercent, 1);
  assert.equal(res.favorable, false);
});

test("computeSlippage calculates negative slippage when landed exceeds quoted", () => {
  const res = computeSlippage({
    domain: "favorable.example",
    assetIn: "USDC",
    assetOut: "BRL",
    quotedAmount: 500,
    landedAmount: 505, // 1% bonus
  });

  assert.equal(res.deltaAmount, -5);
  assert.equal(res.slippageBps, -100);
  assert.equal(res.slippagePercent, -1);
  assert.equal(res.favorable, true);
});

test("computeSlippage rejects non-positive quoted amounts", () => {
  assert.throws(() => {
    computeSlippage({
      domain: "bad.example",
      assetIn: "USDC",
      assetOut: "EURC",
      quotedAmount: 0,
      landedAmount: 10,
    });
  }, /quotedAmount must be strictly positive/);
});

test("aggregateAnchorSlippage suppresses publishing when samples are below floor", () => {
  const samples: SlippageObservation[] = [
    { domain: "sparse.example", assetIn: "USDC", assetOut: "NGN", quotedAmount: 100, landedAmount: 99 },
    { domain: "sparse.example", assetIn: "USDC", assetOut: "NGN", quotedAmount: 100, landedAmount: 98 },
  ];

  const summary = aggregateAnchorSlippage("sparse.example", samples, { minSamples: 3 });
  assert.equal(summary.status, "suppressed_below_floor");
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.medianBps, null);
  assert.match(summary.reason!, /below the statistical floor of 3/);
});

test("aggregateAnchorSlippage computes reliable median and percentiles when sample size is sufficient", () => {
  const samples: SlippageObservation[] = [
    { domain: "active.example", assetIn: "USDC", assetOut: "PHP", quotedAmount: 100, landedAmount: 99 },   // +100 bps
    { domain: "active.example", assetIn: "USDC", assetOut: "PHP", quotedAmount: 100, landedAmount: 98 },   // +200 bps
    { domain: "active.example", assetIn: "USDC", assetOut: "PHP", quotedAmount: 100, landedAmount: 98.5 }, // +150 bps
    { domain: "active.example", assetIn: "USDC", assetOut: "PHP", quotedAmount: 100, landedAmount: 100 },  // 0 bps
    { domain: "active.example", assetIn: "USDC", assetOut: "PHP", quotedAmount: 100, landedAmount: 97 },   // +300 bps
  ];

  const summary = aggregateAnchorSlippage("active.example", samples, { minSamples: 3 });
  assert.equal(summary.status, "reliable");
  assert.equal(summary.sampleCount, 5);
  // Sorted bps: [0, 100, 150, 200, 300] -> median is 150
  assert.equal(summary.medianBps, 150);
  assert.equal(summary.minBps, 0);
  assert.equal(summary.maxBps, 300);
});
