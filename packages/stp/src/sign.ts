import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto";

import { canonicalize } from "./canonical.js";
import type { StpAttestation, StpAttestationUnsigned } from "./schema.js";

export interface Ed25519KeyPair {
  /** DER-encoded SPKI public key, base64. Safe to publish as the `signer` key material. */
  publicKeyB64: string;
  /** DER-encoded PKCS8 private key, base64. Never publish or log this. */
  privateKeyB64: string;
}

/** Generates a fresh Ed25519 keypair for a Landfall attester. */
export function generateSigningKey(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyB64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/**
 * Signs the canonical serialization of every field except `sig`, and
 * returns the attestation with `sig` attached. Round-tripping the same
 * unsigned attestation through the same key always yields the same bytes,
 * because canonicalize() sorts keys — that reproducibility is required by
 * MULTICHAIN.md §3.
 */
export function signAttestation(
  unsigned: StpAttestationUnsigned,
  privateKeyB64: string,
): StpAttestation {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const payload = Buffer.from(canonicalize(unsigned), "utf8");
  const sig = ed25519Sign(null, payload, key).toString("base64");
  return { ...unsigned, sig };
}

/**
 * Verifies `attestation.sig` against `publicKeyB64` over the canonical
 * serialization of every other field. Never throws — a malformed signature,
 * wrong key, or corrupt base64 all just fail closed as `false`.
 */
export function verifyAttestation(attestation: StpAttestation, publicKeyB64: string): boolean {
  const { sig, ...unsigned } = attestation;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    const payload = Buffer.from(canonicalize(unsigned), "utf8");
    return ed25519Verify(null, payload, key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}
