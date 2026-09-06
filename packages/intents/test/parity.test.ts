/**
 * The site is static and cannot import the TypeScript solver, so
 * packages/web/intent.js is a hand-written mirror of it. Two copies of the
 * same arithmetic drift apart — that is not a risk to be careful about, it is
 * something that happens.
 *
 * So this test loads the real browser file, runs the same fixtures through
 * both implementations, and compares every figure. Nothing here is mocked or
 * re-implemented: if the file the browser downloads disagrees with the
 * package, this fails.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { solveIntent } from "../src/solve.js";
import type { Intent, RouteCandidate, SolveResult } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Objects built inside a vm context carry that context's own Array and Object
 * prototypes, so assert/strict's deep comparison reports identical data as
 * unequal. Normalising both sides through JSON compares the values, which is
 * what this test is actually about.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
const BROWSER_FILE = resolve(__dirname, "..", "..", "web", "intent.js");

/** Evaluate the browser file exactly as shipped and hand back its solver. */
function loadBrowserSolver(): (i: Intent, c: readonly RouteCandidate[], m: number) => SolveResult {
  const source = readFileSync(BROWSER_FILE, "utf8");
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: BROWSER_FILE });
  const api = (context as { LandfallIntent?: { solveIntent: unknown } }).LandfallIntent;
  assert.ok(api?.solveIntent, `${BROWSER_FILE} did not define LandfallIntent.solveIntent`);
  return api.solveIntent as ReturnType<typeof loadBrowserSolver>;
}

const CANDIDATES: RouteCandidate[] = [
  { domain: "cowrie.exchange", name: "Cowrie", rateSpread: 0.998, feePercent: 0.8, feeFixed: 0.5, feeSource: "catalog", grade: "D", score: 44, liquidityTier: "low", recentPayments: 4 },
  { domain: "mykobo.co", name: "MyKobo", rateSpread: 0.992, feePercent: 1, feeFixed: 0, feeSource: "live", grade: "C", score: 62, liquidityTier: "medium", recentPayments: 30 },
  { domain: "anclap.com", name: "Anclap", rateSpread: 0.995, feePercent: 2, feeFixed: 10, feeSource: "live", grade: "B", score: 78, liquidityTier: "high", recentPayments: 200 },
  { domain: "ntokens.com", name: "nTokens", rateSpread: 1, feePercent: 20, feeFixed: 0, feeSource: "live", grade: "C", score: 55, liquidityTier: "medium", recentPayments: 15 },
  { domain: "quiet.example", name: "Quiet", rateSpread: 1, feePercent: 0, feeFixed: 0, feeSource: null, grade: "B", score: 71 }, // liquidity omitted on purpose — must default identically in both implementations
  { domain: "gouge.example", name: "Gouger", rateSpread: 1, feePercent: 120, feeFixed: 0, feeSource: "live", grade: "F", score: 12, liquidityTier: "unknown", recentPayments: null },
];

const INTENTS: Intent[] = [
  { from: "USDC", to: "NGN", basis: "send", amount: 100 },
  { from: "USDC", to: "NGN", basis: "send", amount: 5 },
  { from: "USDC", to: "NGN", basis: "send", amount: 1000 },
  { from: "USDC", to: "NGN", basis: "receive", amount: 500_000 },
  { from: "USDC", to: "NGN", basis: "receive", amount: 1_000 },
  { from: "USDC", to: "NGN", basis: "receive", amount: 25_000_000 },
  { from: "USDC", to: "NGN", basis: "send", amount: 100, minGrade: "B" },
  { from: "USDC", to: "NGN", basis: "receive", amount: 500_000, requirePricedTerms: true },
  { from: "USDC", to: "NGN", basis: "receive", amount: 500_000, minGrade: "C", requirePricedTerms: true },
  { from: "USDC", to: "NGN", basis: "send", amount: 100, sortBy: "verified" },
  { from: "USDC", to: "NGN", basis: "send", amount: 1000, sortBy: "verified" },
  { from: "USDC", to: "NGN", basis: "receive", amount: 500_000, sortBy: "verified" },
  { from: "USDC", to: "NGN", basis: "send", amount: 100, sortBy: "verified", minGrade: "C" },
];

test("the browser mirror agrees with the package on every fixture", () => {
  const browserSolve = loadBrowserSolver();

  for (const intent of INTENTS) {
    const mine = solveIntent(intent, CANDIDATES, 1610.5);
    const theirs = browserSolve(intent, CANDIDATES, 1610.5);

    const label = `${intent.basis} ${intent.amount}` +
      (intent.minGrade ? ` minGrade=${intent.minGrade}` : "") +
      (intent.requirePricedTerms ? " pricedOnly" : "");

    assert.equal(theirs.unsatisfiable, mine.unsatisfiable, `${label}: unsatisfiable`);
    assert.deepEqual(
      plain(theirs.solutions.map((s) => s.domain)),
      mine.solutions.map((s) => s.domain),
      `${label}: ranking`,
    );
    assert.deepEqual(
      plain(theirs.rejected.map((s) => [s.domain, s.rejected])),
      mine.rejected.map((s) => [s.domain, s.rejected]),
      `${label}: rejections`,
    );

    for (let i = 0; i < mine.solutions.length; i++) {
      const a = mine.solutions[i]!;
      const b = theirs.solutions[i]!;
      for (const field of ["send", "receive", "rate", "fee", "priced", "feeSource", "grade", "liquidityTier", "recentPayments"] as const) {
        assert.deepEqual(plain(b[field]), a[field], `${label}: ${a.domain}.${field}`);
      }
    }
  }
});

test("the browser mirror exposes the same grade ordering", () => {
  const source = readFileSync(BROWSER_FILE, "utf8");
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: BROWSER_FILE });
  const api = (context as { LandfallIntent: { GRADE_ORDER: string[] } }).LandfallIntent;
  assert.deepEqual(JSON.parse(JSON.stringify(api.GRADE_ORDER)), ["U", "F", "D", "C", "B", "A"]);
});
