/**
 * The zero-knowledge slot (SPEC.md §10).
 *
 * Stellar's ZK primitive layer went live with X-Ray / Protocol 25 in January
 * 2026, so proving membership of a committed set without revealing the record
 * is now possible on this network. This module defines where such a proof
 * sits in a bundle and what a verifier must do with it.
 *
 * **No circuit is implemented, and this file will not pretend one is.**
 *
 * That is a deliberate refusal rather than an omission. Writing and auditing a
 * production ZK circuit is specialist work measured in months; shipping an
 * unaudited circuit whose `verify()` returned `true` would produce bundles
 * that *look* privacy-preserving and prove nothing — strictly worse than
 * having no ZK support, because someone would rely on it. The functions below
 * therefore either return "unsupported" or throw, and `verifyZkProof` returns
 * a result whose `verified` field is never true for an unknown scheme.
 *
 * What this file does buy: bundles produced today carry the slot, so when a
 * real circuit exists it can be added without a format migration, and every
 * existing bundle stays parseable.
 */

/** Schemes a future implementation might support. None is implemented. */
export type ZkScheme = "groth16" | "plonk" | "stark";

export interface ZkProof {
  scheme: ZkScheme;
  /** What the proof asserts, in words, for a reader who cannot check the maths. */
  statement: string;
  /** Opaque proof bytes, base64. */
  proof: string;
  /** Public inputs the verifier must bind the proof to — at minimum, the root. */
  publicInputs: Record<string, string>;
  /** Identifier for the exact circuit and its audit, so a reader can look it up. */
  circuitId: string;
}

export interface ZkVerificationResult {
  verified: boolean;
  /** Why, in terms a non-cryptographer can act on. */
  reason: string;
  /** True when the failure is "we cannot check this", not "this is invalid". */
  unsupported: boolean;
}

/** Schemes this build can actually verify. Empty, and honestly so. */
export const SUPPORTED_SCHEMES: readonly ZkScheme[] = [];

export function isSchemeSupported(scheme: string): boolean {
  return (SUPPORTED_SCHEMES as readonly string[]).includes(scheme);
}

/**
 * Verify a ZK proof attached to a bundle.
 *
 * Always reports `verified: false` in this build. The distinction that matters
 * to a caller is `unsupported`: an unverifiable proof is not a failed proof,
 * and a bundle carrying one should be reported as "membership not
 * independently confirmed" rather than "invalid".
 */
export function verifyZkProof(proof: ZkProof | null | undefined): ZkVerificationResult {
  if (!proof) {
    return {
      verified: false,
      unsupported: false,
      reason: "No ZK proof attached. Membership is proved by the Merkle path instead, which reveals the leaf hash.",
    };
  }

  if (!isSchemeSupported(proof.scheme)) {
    return {
      verified: false,
      unsupported: true,
      reason:
        `Bundle carries a "${proof.scheme}" proof, which this build cannot verify — no circuit is implemented here. ` +
        `Treat the ZK claim as unchecked, not as failed. The Merkle path in the same bundle is unaffected and ` +
        `can be verified normally.`,
    };
  }

  // Unreachable while SUPPORTED_SCHEMES is empty. Left as an explicit throw so
  // that adding a scheme to the list without implementing it fails loudly
  // rather than silently returning "verified: false" forever.
  throw new Error(
    `Scheme "${proof.scheme}" is listed as supported but has no verifier implementation. ` +
      `Implement it or remove it from SUPPORTED_SCHEMES.`,
  );
}

/**
 * Structural check on a proof object, independent of whether it can be
 * verified. Catches a malformed slot early so it is not mistaken for a
 * cryptographic failure later.
 */
export function validateZkProof(proof: ZkProof): string[] {
  const problems: string[] = [];
  if (!proof.scheme) problems.push("ZK proof has no scheme.");
  if (!proof.proof) problems.push("ZK proof carries no proof bytes.");
  if (!proof.circuitId) {
    problems.push("ZK proof has no circuitId — a proof nobody can trace to a reviewed circuit is not evidence.");
  }
  if (!proof.publicInputs || !proof.publicInputs["root"]) {
    problems.push("ZK proof must bind at least the anchor root as a public input, or it proves membership of nothing in particular.");
  }
  return problems;
}
