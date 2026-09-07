import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluatePaymentRequirements } from "../src/evaluate.js";
import type { PaymentRequirements } from "../src/types.js";

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

test("a Stellar G-address payee is run through the injected Trust Check function", async () => {
  let calledWith: string | null = null;
  const results = await evaluatePaymentRequirements([requirement()], async (address) => {
    calledWith = address;
    return { riskLevel: "low" };
  });
  assert.equal(calledWith, G_ADDR);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.supported, true);
  if (results[0]?.supported) {
    assert.deepEqual(results[0].trustCheck, { riskLevel: "low" });
  }
});

test("stellar:testnet is also supported", async () => {
  const results = await evaluatePaymentRequirements(
    [requirement({ network: "stellar:testnet" })],
    async () => ({ riskLevel: "low" }),
  );
  assert.equal(results[0]?.supported, true);
});

test("a non-Stellar network is reported unsupported, never silently dropped, and never calls Trust Check", async () => {
  let called = false;
  const results = await evaluatePaymentRequirements(
    [requirement({ network: "eip155:8453" })],
    async () => {
      called = true;
      return { riskLevel: "low" };
    },
  );
  assert.equal(called, false);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.supported, false);
  if (!results[0]?.supported) {
    assert.match(results[0].reason, /not Stellar/);
  }
});

test("a Soroban contract payTo on a Stellar network is unsupported, not guessed at", async () => {
  const results = await evaluatePaymentRequirements(
    [requirement({ payTo: C_ADDR })],
    async () => ({ riskLevel: "low" }),
  );
  assert.equal(results[0]?.supported, false);
  if (!results[0]?.supported) {
    assert.match(results[0].reason, /not a classic Stellar account/);
  }
});

test("every requirement in accepts gets its own assessment, order preserved", async () => {
  const results = await evaluatePaymentRequirements(
    [requirement({ payTo: G_ADDR }), requirement({ network: "eip155:8453" }), requirement({ payTo: C_ADDR })],
    async () => ({ riskLevel: "low" }),
  );
  assert.equal(results.length, 3);
  assert.equal(results[0]?.supported, true);
  assert.equal(results[1]?.supported, false);
  assert.equal(results[2]?.supported, false);
});

test("an empty accepts array yields an empty result", async () => {
  const results = await evaluatePaymentRequirements([], async () => ({ riskLevel: "low" }));
  assert.deepEqual(results, []);
});

test("the original requirement object is passed through unmodified on both paths", async () => {
  const req = requirement({ extra: { foo: "bar" } });
  const [supported] = await evaluatePaymentRequirements([req], async () => ({ riskLevel: "low" }));
  assert.deepEqual(supported?.requirement, req);

  const [unsupported] = await evaluatePaymentRequirements(
    [requirement({ network: "eip155:8453", extra: { foo: "baz" } })],
    async () => ({ riskLevel: "low" }),
  );
  assert.deepEqual(unsupported?.requirement.extra, { foo: "baz" });
});
