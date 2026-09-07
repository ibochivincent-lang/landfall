/**
 * Dispute-response attestations — Sentinel's "Attested" stage, built for the
 * accused rather than the accuser.
 *
 * The obvious reading of "Attested" was to sign the report+dispute pair, the
 * way settlement events are signed. That was deliberately not built, and the
 * reason is in types.ts's constraints: a report is an accusation about a
 * named party. A signature makes a claim portable and permanent, and a
 * portable accusation arrives stripped of everything that holds it honest —
 * the disclaimer, the attached response, the "counts are never a verdict"
 * rule. Those live in the API payload and the page, not in a signature. So
 * signing the accusation would export the claim and leave its safeguards
 * behind, which is precisely the failure this module exists to prevent.
 *
 * What is signed instead is only the response. This attestation says: the
 * holder of THIS Stellar account answered report N at time T, and proved
 * control of the account by signature while doing so. It is exculpatory by
 * construction — useful to the reported party, who chooses whether to show
 * it, and worth nothing to anyone trying to spread an allegation.
 *
 * Deliberately absent from the payload: the report's category, the
 * reporter's note, the cited evidence hash, and any count. `reportId` is the
 * one unavoidable concession — you cannot attest a response without
 * referencing what was responded to — but it is an opaque row id that
 * carries none of the allegation with it.
 *
 * Signing follows the convention already used for settlement attestations
 * (packages/sdk/src/attest.ts): signed when a key is configured, otherwise a
 * reproducible SHA-256 digest of the canonical serialization and
 * `signed: false`, because an unsigned digest anyone can recompute is honest
 * and a manufactured signature is not.
 */

import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";

import { canonicalize } from "../../stp/src/canonical.js";

/** Every field the signature covers. `sig` is excluded — a field cannot sign over itself. */
export interface DisputeAttestationUnsigned {
  landfall_attestation: "dispute-response";
  version: "1";
  /** The Stellar account that responded, and proved it controls the key. */
  subject: string;
  /** Opaque report row id. Carries none of the allegation — see the file header. */
  report_id: string;
  /** Server clock when the response was accepted, ISO-8601 UTC. */
  responded_at: string;
  /**
   * Always true. Landfall verified an Ed25519 signature from `subject`'s own
   * key before writing the response, so this attestation is only ever built
   * for a response whose control proof already passed. It is stated
   * explicitly rather than implied, so a reader of the payload alone knows
   * what was checked.
   */
  control_proven: true;
  /** The responder's own words, verbatim. Theirs to publish. */
  response: string;
  /** Landfall attester key id. */
  signer: string;
}

export interface DisputeAttestation extends DisputeAttestationUnsigned {
  sig: string;
}

export interface DisputeAttestationResult {
  attestation: DisputeAttestationUnsigned | DisputeAttestation;
  /** SHA-256 of the canonical serialization. Recomputable by anyone from the body alone. */
  digest: string;
  signed: boolean;
}

export function disputeAttestationDigest(unsigned: DisputeAttestationUnsigned): string {
  return createHash("sha256").update(canonicalize(unsigned), "utf8").digest("hex");
}

export interface BuildDisputeAttestationInput {
  subject: string;
  reportId: string;
  respondedAt: string;
  response: string;
  signer: string;
}

/** Pure: builds the exact body that gets signed, with no clock and no I/O. */
export function buildDisputeAttestation(input: BuildDisputeAttestationInput): DisputeAttestationUnsigned {
  return {
    landfall_attestation: "dispute-response",
    version: "1",
    subject: input.subject,
    report_id: input.reportId,
    responded_at: input.respondedAt,
    control_proven: true,
    response: input.response,
    signer: input.signer,
  };
}

/**
 * Signs when `privateKeyB64` is supplied, otherwise returns the same body
 * with `signed: false` and its digest — never a placeholder signature.
 */
export function attestDispute(
  unsigned: DisputeAttestationUnsigned,
  privateKeyB64?: string,
): DisputeAttestationResult {
  const digest = disputeAttestationDigest(unsigned);
  if (!privateKeyB64) return { attestation: unsigned, digest, signed: false };

  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const sig = ed25519Sign(null, Buffer.from(canonicalize(unsigned), "utf8"), key).toString("base64");
  return { attestation: { ...unsigned, sig }, digest, signed: true };
}

/** Never throws — a malformed signature, wrong key or corrupt base64 all fail closed as false. */
export function verifyDisputeAttestation(attestation: DisputeAttestation, publicKeyB64: string): boolean {
  const { sig, ...unsigned } = attestation;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return ed25519Verify(null, Buffer.from(canonicalize(unsigned), "utf8"), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}
