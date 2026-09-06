/**
 * api/[...path].js has no build step, so it can't import this TypeScript
 * package at runtime — analyzeTrustCheck there is a hand-written mirror,
 * the same situation packages/web/intent.js and the fiat-confirmation
 * evaluator are already in. This test imports the actual deployed file and
 * runs a shared fixture set through both implementations, failing on any
 * disagreement.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeTrustCheck } from "../src/analyze.js";
import type { ObservedPayment, TrustCheckInput } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_FILE = resolve(__dirname, "..", "..", "..", "api", "[...path].js");

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

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

const FIXTURES: TrustCheckInput[] = [
  { address: ADDR, oldestRetainedPaymentAt: null, recentPayments: [], recentPaymentsTruncated: false, checkedAt: "2026-01-01T00:00:00Z" },
  {
    address: ADDR,
    oldestRetainedPaymentAt: "2025-01-01T00:00:00Z",
    recentPayments: Array.from({ length: 25 }, (_, i) => pay({ from: `GC${i}0000000000000000000000000000000000000000000000` })),
    recentPaymentsTruncated: true,
    checkedAt: "2026-01-01T00:00:00Z",
  },
  {
    address: ADDR,
    oldestRetainedPaymentAt: "2025-12-31T00:00:00Z",
    recentPayments: [
      pay({ from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:00:00Z" }),
      pay({ from: ADDR, to: OTHER2, amount: "99", createdAt: "2026-01-01T00:01:00Z" }),
      pay({ from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:02:00Z" }),
      pay({ from: ADDR, to: OTHER2, amount: "99", createdAt: "2026-01-01T00:03:00Z" }),
      pay({ from: OTHER, to: ADDR, amount: "100", createdAt: "2026-01-01T00:04:00Z" }),
      pay({ from: ADDR, to: OTHER2, amount: "99", createdAt: "2026-01-01T00:05:00Z" }),
    ],
    recentPaymentsTruncated: false,
    checkedAt: "2026-01-01T00:00:00Z",
  },
  {
    address: ADDR,
    oldestRetainedPaymentAt: "2020-01-01T00:00:00Z",
    recentPayments: [
      ...Array.from({ length: 8 }, () => pay({ from: OTHER, amount: "100" })),
      pay({ from: OTHER2, amount: "50" }),
    ],
    recentPaymentsTruncated: false,
    checkedAt: "2026-01-01T00:00:00Z",
  },
  {
    address: ADDR,
    oldestRetainedPaymentAt: "2025-12-30T00:00:00Z",
    recentPayments: Array.from({ length: 10 }, () => pay({})),
    recentPaymentsTruncated: false,
    checkedAt: "2026-01-01T00:00:00Z",
  },
];

test("the deployed API's analyzeTrustCheck agrees with the package on every fixture", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as { analyzeTrustCheck?: (i: TrustCheckInput) => unknown };
  assert.ok(typeof mod.analyzeTrustCheck === "function", `${API_FILE} did not export analyzeTrustCheck`);

  for (const [i, fixture] of FIXTURES.entries()) {
    const mine = analyzeTrustCheck(fixture);
    const theirs = JSON.parse(JSON.stringify(mod.analyzeTrustCheck(fixture))) as typeof mine;
    assert.deepEqual(theirs, mine, `fixture ${i}`);
  }
});
