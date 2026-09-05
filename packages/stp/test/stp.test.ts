import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalize } from "../src/canonical.js";
import { parseStpAttestation, type StpAttestationUnsigned } from "../src/schema.js";
import { generateSigningKey, signAttestation, verifyAttestation } from "../src/sign.js";

function sampleUnsigned(): StpAttestationUnsigned {
  return {
    stp_version: "1",
    anchor_id: "anchor:example.com",
    chain: "stellar",
    asset: "USDC",
    direction: "deposit",
    amount: "1250.50",
    onchain_ref: "a1b2c3",
    fiat_leg_ref: null,
    evidence_tier: "PROVEN",
    evidence_detail: "stellar_ledger",
    keystone_ref: null,
    observed_at: "2026-09-03T12:00:00Z",
    signer: "landfall-attester-1",
  };
}

test("canonicalize is independent of input key order", () => {
  const a = canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalize({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
});

test("sign/verify round-trips and is reproducible for the same key and payload", () => {
  const key = generateSigningKey();
  const unsigned = sampleUnsigned();

  const signed1 = signAttestation(unsigned, key.privateKeyB64);
  const signed2 = signAttestation(unsigned, key.privateKeyB64);

  assert.equal(signed1.sig, signed2.sig, "same payload + key must produce the same signature");
  assert.equal(verifyAttestation(signed1, key.publicKeyB64), true);
});

test("verification fails if any signed field is tampered with", () => {
  const key = generateSigningKey();
  const signed = signAttestation(sampleUnsigned(), key.privateKeyB64);

  const tampered = { ...signed, amount: "999999.00" };
  assert.equal(verifyAttestation(tampered, key.publicKeyB64), false);
});

test("verification fails against the wrong public key", () => {
  const key = generateSigningKey();
  const otherKey = generateSigningKey();
  const signed = signAttestation(sampleUnsigned(), key.privateKeyB64);

  assert.equal(verifyAttestation(signed, otherKey.publicKeyB64), false);
});

test("verification fails closed on garbage input instead of throwing", () => {
  const key = generateSigningKey();
  const signed = signAttestation(sampleUnsigned(), key.privateKeyB64);

  assert.equal(verifyAttestation({ ...signed, sig: "not-base64!!" }, key.publicKeyB64), false);
  assert.equal(verifyAttestation(signed, "not-a-key"), false);
});

test("schema rejects an inflated or missing evidence_tier", () => {
  const bad = { ...sampleUnsigned(), evidence_tier: "CERTAIN" };
  assert.throws(() => parseStpAttestation({ ...bad, sig: "x" }));
});

test("schema rejects a non-decimal amount", () => {
  const bad = { ...sampleUnsigned(), amount: "not-a-number" };
  assert.throws(() => parseStpAttestation({ ...bad, sig: "x" }));
});

test("schema accepts a fully-formed signed attestation", () => {
  const key = generateSigningKey();
  const signed = signAttestation(sampleUnsigned(), key.privateKeyB64);
  assert.doesNotThrow(() => parseStpAttestation(signed));
});
