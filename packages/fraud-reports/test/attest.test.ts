import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attestDispute,
  buildDisputeAttestation,
  disputeAttestationDigest,
  verifyDisputeAttestation,
  type DisputeAttestation,
} from "../src/attest.js";
import { generateSigningKey } from "../../stp/src/sign.js";

const SUBJECT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function unsigned() {
  return buildDisputeAttestation({
    subject: SUBJECT,
    reportId: "42",
    respondedAt: "2026-09-07T12:00:00Z",
    response: "That payment was refunded the same day, ref 8891.",
    signer: "landfall-attester-1",
  });
}

test("the payload carries the response and nothing about the accusation", () => {
  const a = unsigned();
  assert.equal(a.subject, SUBJECT);
  assert.equal(a.report_id, "42");
  assert.equal(a.control_proven, true);
  assert.match(a.response, /refunded the same day/);

  // The whole point of option 1: no field here can carry an allegation.
  const keys = Object.keys(a);
  for (const forbidden of ["category", "note", "evidence_tx_hash", "evidenceTxHash", "status", "total", "reports"]) {
    assert.ok(!keys.includes(forbidden), `attestation must not carry "${forbidden}"`);
  }
  const serialized = JSON.stringify(a);
  assert.ok(!/did_not_receive|impersonation|unauthorized_debit|wrong_amount/.test(serialized));
});

test("without a key it is digested, not signed, and says so", () => {
  const r = attestDispute(unsigned());
  assert.equal(r.signed, false);
  assert.equal(typeof r.digest, "string");
  assert.equal(r.digest.length, 64);
  assert.ok(!("sig" in r.attestation));
});

test("the digest is reproducible from the body alone, with no key", () => {
  const a = unsigned();
  assert.equal(disputeAttestationDigest(a), disputeAttestationDigest({ ...a }));
  assert.equal(attestDispute(a).digest, disputeAttestationDigest(a));
});

test("a signed attestation verifies against the published key", () => {
  const { publicKeyB64, privateKeyB64 } = generateSigningKey();
  const r = attestDispute(unsigned(), privateKeyB64);
  assert.equal(r.signed, true);
  assert.ok("sig" in r.attestation);
  assert.equal(verifyDisputeAttestation(r.attestation as DisputeAttestation, publicKeyB64), true);
});

test("signing does not change the digest — it covers the same bytes", () => {
  const { privateKeyB64 } = generateSigningKey();
  const a = unsigned();
  assert.equal(attestDispute(a, privateKeyB64).digest, attestDispute(a).digest);
});

test("verification fails closed on a wrong key, a tampered field, and a corrupt signature", () => {
  const { privateKeyB64 } = generateSigningKey();
  const other = generateSigningKey();
  const signed = attestDispute(unsigned(), privateKeyB64).attestation as DisputeAttestation;

  assert.equal(verifyDisputeAttestation(signed, other.publicKeyB64), false);
  assert.equal(verifyDisputeAttestation({ ...signed, response: "something else" }, other.publicKeyB64), false);
  assert.equal(verifyDisputeAttestation({ ...signed, sig: "not-base64!!" }, other.publicKeyB64), false);
});

test("a tampered response is caught by the right key too", () => {
  const { publicKeyB64, privateKeyB64 } = generateSigningKey();
  const signed = attestDispute(unsigned(), privateKeyB64).attestation as DisputeAttestation;
  assert.equal(verifyDisputeAttestation(signed, publicKeyB64), true);
  assert.equal(verifyDisputeAttestation({ ...signed, response: "I admit it" }, publicKeyB64), false);
  assert.equal(verifyDisputeAttestation({ ...signed, subject: "GDIFFERENT" }, publicKeyB64), false);
});
