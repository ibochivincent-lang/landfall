/**
 * api/[...path].js hand-mirrors buildDisputeAttestation/attestDispute (and
 * canonicalize, from packages/stp) because it has no build step. This runs
 * shared fixtures through the deployed file and the real package, and
 * asserts identical bytes — a digest that differs between them would mean a
 * responder's attestation could not be verified against the published one.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  attestDispute,
  buildDisputeAttestation,
  disputeAttestationDigest,
  verifyDisputeAttestation,
  type BuildDisputeAttestationInput,
  type DisputeAttestation,
} from "../src/attest.js";
import { generateSigningKey } from "../../stp/src/sign.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_FILE = resolve(__dirname, "..", "..", "..", "api", "[...path].js");

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

const SUBJECT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const INPUTS: BuildDisputeAttestationInput[] = [
  { subject: SUBJECT, reportId: "1", respondedAt: "2026-09-07T12:00:00Z", response: "Refunded same day, ref 8891.", signer: "landfall-attester-1" },
  { subject: SUBJECT, reportId: "42", respondedAt: "2026-01-01T00:00:00Z", response: "", signer: "landfall-unattributed" },
  { subject: SUBJECT, reportId: "999", respondedAt: "2026-12-31T23:59:59Z", response: "Unicode: café — “quoted”, \\ backslash, \"double\".", signer: "k1" },
];

test("the deployed API builds byte-identical attestation bodies", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    buildDisputeAttestation?: (i: BuildDisputeAttestationInput) => unknown;
  };
  assert.equal(typeof mod.buildDisputeAttestation, "function", "buildDisputeAttestation missing from api/[...path].js");
  for (const input of INPUTS) {
    assert.deepEqual(mod.buildDisputeAttestation!(input), buildDisputeAttestation(input));
  }
});

test("digests agree exactly — the whole point of a mirrored canonicalize", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    buildDisputeAttestation?: (i: BuildDisputeAttestationInput) => never;
    disputeAttestationDigest?: (u: unknown) => string;
  };
  for (const input of INPUTS) {
    const unsigned = buildDisputeAttestation(input);
    assert.equal(mod.disputeAttestationDigest!(unsigned), disputeAttestationDigest(unsigned));
  }
});

test("unsigned results match, including the signed:false flag", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    buildDisputeAttestation?: (i: BuildDisputeAttestationInput) => never;
    attestDispute?: (u: unknown, k?: string) => unknown;
  };
  for (const input of INPUTS) {
    const unsigned = buildDisputeAttestation(input);
    assert.deepEqual(mod.attestDispute!(unsigned), attestDispute(unsigned));
  }
});

test("a signature minted by the deployed file verifies with the package's verifier", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    buildDisputeAttestation?: (i: BuildDisputeAttestationInput) => never;
    attestDispute?: (u: unknown, k?: string) => { attestation: DisputeAttestation; digest: string; signed: boolean };
  };
  const { publicKeyB64, privateKeyB64 } = generateSigningKey();

  for (const input of INPUTS) {
    const unsigned = buildDisputeAttestation(input);
    const fromApi = mod.attestDispute!(unsigned, privateKeyB64);
    const fromPkg = attestDispute(unsigned, privateKeyB64);

    assert.equal(fromApi.signed, true);
    assert.equal(fromApi.digest, fromPkg.digest);
    // Ed25519 is deterministic, so the same body and key must produce the
    // same signature on both sides — not merely two valid ones.
    assert.deepEqual(fromApi.attestation, fromPkg.attestation);
    assert.equal(verifyDisputeAttestation(fromApi.attestation, publicKeyB64), true);
  }
});
