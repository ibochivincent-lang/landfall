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
    return { ok: true as const, trustCheck: { riskLevel: "low" } };
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
    async () => ({ ok: true as const, trustCheck: { riskLevel: "low" } }),
  );
  assert.equal(results[0]?.supported, true);
});

test("a non-Stellar network is reported unsupported, never silently dropped, and never calls Trust Check", async () => {
  let called = false;
  const results = await evaluatePaymentRequirements(
    [requirement({ network: "eip155:8453" })],
    async () => {
      called = true;
      return { ok: true as const, trustCheck: { riskLevel: "low" } };
    },
  );
  assert.equal(called, false);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.supported, false);
  if (!results[0]?.supported) {
    assert.match(results[0].reason, /not Stellar/);
  }
});

test("a Soroban contract payTo on a Stellar network is unsupported with isContract: true", async () => {
  const results = await evaluatePaymentRequirements(
    [requirement({ payTo: C_ADDR })],
    async () => ({ ok: true as const, trustCheck: { riskLevel: "low" } }),
  );
  assert.equal(results[0]?.supported, false);
  if (!results[0]?.supported) {
    assert.match(results[0].reason, /Soroban contract/);
    assert.equal(results[0].isContract, true);
  }
});

test("a muxed account (M...) is unwrapped to its base G... account and evaluated with memo preserved", async () => {
  const MUXED_ADDR = "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KAAAAAAAAABQHGNKE";
  let evaluatedAddress: string | null = null;
  const results = await evaluatePaymentRequirements(
    [requirement({ payTo: MUXED_ADDR })],
    async (address) => {
      evaluatedAddress = address;
      return { ok: true as const, trustCheck: { riskLevel: "low" } };
    },
  );
  assert.equal(evaluatedAddress, G_ADDR);
  assert.equal(results[0]?.supported, true);
  if (results[0]?.supported) {
    assert.equal(results[0].isMuxed, true);
    assert.equal(results[0].baseAccount, G_ADDR);
    assert.equal(results[0].memoId, "12345");
  }
});

test("every requirement in accepts gets its own assessment, order preserved", async () => {
  const results = await evaluatePaymentRequirements(
    [requirement({ payTo: G_ADDR }), requirement({ network: "eip155:8453" }), requirement({ payTo: C_ADDR })],
    async () => ({ ok: true as const, trustCheck: { riskLevel: "low" } }),
  );
  assert.equal(results.length, 3);
  assert.equal(results[0]?.supported, true);
  assert.equal(results[1]?.supported, false);
  assert.equal(results[2]?.supported, false);
});

test("an empty accepts array yields an empty result", async () => {
  const results = await evaluatePaymentRequirements([], async () => ({ ok: true as const, trustCheck: { riskLevel: "low" } }));
  assert.deepEqual(results, []);
});

test("the original requirement object is passed through unmodified on both paths", async () => {
  const req = requirement({ extra: { foo: "bar" } });
  const [supported] = await evaluatePaymentRequirements([req], async () => ({ ok: true as const, trustCheck: { riskLevel: "low" } }));
  assert.deepEqual(supported?.requirement, req);

  const [unsupported] = await evaluatePaymentRequirements(
    [requirement({ network: "eip155:8453", extra: { foo: "baz" } })],
    async () => ({ ok: true as const, trustCheck: { riskLevel: "low" } }),
  );
  assert.deepEqual(unsupported?.requirement.extra, { foo: "baz" });
});

/* ─── Per-payee failure isolation ────────────────────────────────────────
   These cover the bug the worked example in examples/x402-payee-check
   surfaced: one unresolvable payee used to fail the entire batch with a 502,
   which threw away the answers for every other payee AND converted the most
   damning finding this check can make — "that account is not on the ledger"
   — into what looked like an outage. */

test("a payee the checker cannot resolve is unsupported, not an exception", async () => {
  const results = await evaluatePaymentRequirements([requirement()], async () => ({
    ok: false as const,
    reason: "no account for that address exists on the Stellar network.",
    retryable: false,
  }));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.supported, false);
  if (!results[0]?.supported) {
    assert.match(results[0].reason, /no account/);
    assert.equal(results[0].retryable, false);
  }
});

test("a transient failure is marked retryable, so it cannot read as 'address does not exist'", async () => {
  const results = await evaluatePaymentRequirements([requirement()], async () => ({
    ok: false as const,
    reason: "could not reach Horizon.",
    retryable: true,
  }));
  assert.equal(results[0]?.supported, false);
  if (!results[0]?.supported) assert.equal(results[0].retryable, true);
});

test("one bad payee never removes another's answer", async () => {
  const good = "GBN32NH6TMWE4ZD4G245CF3UVOQRXD4FK3FDCLZ4DE5642HWFKSLLRMB";
  const results = await evaluatePaymentRequirements(
    [requirement({ payTo: G_ADDR }), requirement({ payTo: good })],
    async (address) =>
      address === G_ADDR
        ? { ok: false as const, reason: "no such account.", retryable: false }
        : { ok: true as const, trustCheck: { riskLevel: "low" } },
  );

  assert.equal(results.length, 2);
  assert.equal(results[0]?.supported, false);
  assert.equal(results[1]?.supported, true, "the good payee's answer must survive the bad one");
});

test("a checker that throws still rejects — classification belongs to the caller", async () => {
  await assert.rejects(
    () => evaluatePaymentRequirements([requirement()], async () => { throw new Error("boom"); }),
    /boom/,
    "an unclassified throw is a caller bug and must not be silently swallowed as 'unsupported'",
  );
});
