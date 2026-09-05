import { createHash } from "node:crypto";

import { canonicalize } from "../../stp/src/canonical.js";
import type { StpAttestation, StpAttestationUnsigned } from "../../stp/src/schema.js";
import { signAttestation } from "../../stp/src/sign.js";
import type { SettlementEvent } from "../../adapters/src/types.js";

export interface AttestationOptions {
  /** Landfall attester key id recorded on the attestation. */
  signer: string;
  /** Base64 PKCS8 Ed25519 private key. Without it the attestation is built and digested, but left unsigned. */
  privateKeyB64?: string;
}

export interface BuiltAttestation {
  attestation: StpAttestationUnsigned | StpAttestation;
  /**
   * SHA-256 of the canonical serialization of the signed fields. Anyone can
   * recompute this from the attestation body with no key material at all, so
   * an unsigned attestation is still checkable for tampering against a
   * published digest — it just isn't attributable to Landfall.
   */
  digest: string;
  signed: boolean;
}

/** Maps an adapter's SettlementEvent onto the wire-format STP attestation body (MULTICHAIN.md §3). */
export function toUnsignedAttestation(event: SettlementEvent, signer: string): StpAttestationUnsigned {
  return {
    stp_version: "1",
    anchor_id: event.anchorId,
    chain: event.chain,
    asset: event.asset,
    direction: event.direction,
    amount: event.amount,
    onchain_ref: event.onchainRef,
    fiat_leg_ref: event.fiatLegRef ?? null,
    evidence_tier: event.evidenceTier,
    evidence_detail: event.evidenceDetail,
    keystone_ref: event.keystoneRef ?? null,
    observed_at: event.observedAt,
    signer,
  };
}

export function attestationDigest(unsigned: StpAttestationUnsigned): string {
  return createHash("sha256").update(canonicalize(unsigned), "utf8").digest("hex");
}

/**
 * Builds (and, when a key is configured, signs) one attestation.
 *
 * Signing is optional on purpose: without a real published attester key, a
 * signature from a throwaway key proves nothing to anyone, so this reports
 * `signed: false` rather than manufacturing reassurance. The digest is
 * emitted either way, because that part is genuinely verifiable by anyone.
 */
export function buildAttestation(event: SettlementEvent, opts: AttestationOptions): BuiltAttestation {
  const unsigned = toUnsignedAttestation(event, opts.signer);
  const digest = attestationDigest(unsigned);

  if (!opts.privateKeyB64) {
    return { attestation: unsigned, digest, signed: false };
  }
  return { attestation: signAttestation(unsigned, opts.privateKeyB64), digest, signed: true };
}
