/**
 * api/[...path].js has no build step, so it can't import this package at
 * runtime — evaluatePaymentRequirements there is a hand-written mirror,
 * the same situation Trust Check's, Fraud Reports' and the Investigator's
 * mirrors are already in. This imports the actual deployed file and runs
 * shared fixtures through both.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluatePaymentRequirements } from "../src/evaluate.js";
import type { PaymentRequirements } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_FILE = resolve(__dirname, "..", "..", "..", "api", "[...path].js");

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

const G_ADDR = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const C_ADDR = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:pubnet",
    asset: USDC_TESTNET,
    amount: "1000000",
    payTo: G_ADDR,
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

const FIXTURES: PaymentRequirements[][] = [
  [requirement()],
  [requirement({ network: "stellar:testnet" })],
  [requirement({ network: "eip155:8453" })],
  [requirement({ payTo: C_ADDR })],
  [requirement(), requirement({ network: "eip155:8453" }), requirement({ payTo: C_ADDR })],
  [],
];

test("the deployed API's x402 evaluator agrees with the package on every fixture", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    evaluatePaymentRequirements?: (
      accepts: PaymentRequirements[],
      run: (address: string) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  assert.equal(typeof mod.evaluatePaymentRequirements, "function", "evaluatePaymentRequirements missing from api/[...path].js");

  // Must return the Result shape the checker contract now specifies. An
  // earlier version of this stub returned a bare Trust Check result, which
  // made both sides take the failure branch identically — parity passed
  // while exercising nothing. Assert the success path is actually reached.
  const stubOk = async (address: string) => ({ ok: true as const, trustCheck: { address, riskLevel: "low" } });
  const stubMissing = async () => ({ ok: false as const, reason: "no such account.", retryable: false });
  const stubDown = async () => ({ ok: false as const, reason: "horizon unreachable.", retryable: true });

  for (const accepts of FIXTURES) {
    for (const stub of [stubOk, stubMissing, stubDown]) {
      const pkgResult = await evaluatePaymentRequirements(accepts, stub);
      const apiResult = await mod.evaluatePaymentRequirements!(accepts, stub);
      assert.deepEqual(apiResult, pkgResult);
    }
  }

  // Guard against the coincidental pass returning: at least one fixture must
  // produce a supported payee, or this test proves nothing about that path.
  const checkable = (await evaluatePaymentRequirements(FIXTURES.flat(), stubOk)) as Array<{ supported: boolean }>;
  assert.ok(
    checkable.some((r) => r.supported === true),
    "fixtures must include at least one checkable Stellar payee, or the success path goes untested",
  );
});
