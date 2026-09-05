/**
 * RFC 6962 Merkle tree with namespace domain separation.
 *
 * The construction is Certificate Transparency's, not one invented here, for
 * the reason given in SPEC.md §3: it is the version that has had adversarial
 * attention. Two properties are load-bearing and both are easy to get wrong:
 *
 *  1. Leaf and internal-node preimages are disjoint (0x00 / 0x01 prefixes).
 *     Without this, a record whose bytes equal two concatenated hashes hashes
 *     to the same value as a real internal node, and an attacker can present
 *     an internal node as a committed record.
 *
 *  2. Odd levels split at the largest power of two below n rather than
 *     duplicating the trailing node. Duplication is CVE-2012-2459: two
 *     different record lists collide on one root, so the proof proves less
 *     than it appears to.
 */

import { sha256 } from "@noble/hashes/sha2.js";

/** Every hash in this package is a 32-byte SHA-256 digest. */
export type Hash = Uint8Array;

export const HASH_BYTES = 32;

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`Hex string has odd length: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`Not hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The namespace, UTF-8, NUL-terminated.
 *
 * Bound into every leaf so a proof issued under one namespace cannot be
 * replayed under another. The terminator prevents "cert" + "ificates" and
 * "certificates" + "" producing the same tag.
 */
function namespaceTag(namespace: string): Uint8Array {
  if (namespace.indexOf(String.fromCharCode(0)) !== -1) {
    throw new Error("Namespace may not contain a NUL byte — it is the tag terminator.");
  }
  return concat(new TextEncoder().encode(namespace), new Uint8Array([0x00]));
}

/** leaf(data) = SHA-256(0x00 || namespace || 0x00 || data) */
export function hashLeaf(namespace: string, data: Uint8Array): Hash {
  return sha256(concat(new Uint8Array([LEAF_PREFIX]), namespaceTag(namespace), data));
}

/** node(l, r) = SHA-256(0x01 || l || r) */
export function hashNode(left: Hash, right: Hash): Hash {
  if (left.length !== HASH_BYTES || right.length !== HASH_BYTES) {
    throw new Error("Internal node children must be 32-byte hashes.");
  }
  return sha256(concat(new Uint8Array([NODE_PREFIX]), left, right));
}

/** The empty tree's root is the hash of the empty string (RFC 6962 §2.1). */
export function emptyRoot(): Hash {
  return sha256(new Uint8Array(0));
}

/** Largest power of two strictly less than n. Defined for n >= 2. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Merkle root over already-hashed leaves.
 *
 * Takes leaf hashes rather than raw records so a caller who has hashed
 * incrementally — a large dataset streamed once — does not have to hold every
 * record in memory to get a root.
 */
export function rootFromLeaves(leaves: readonly Hash[]): Hash {
  if (leaves.length === 0) return emptyRoot();
  if (leaves.length === 1) return leaves[0] as Hash;
  const k = splitPoint(leaves.length);
  return hashNode(rootFromLeaves(leaves.slice(0, k)), rootFromLeaves(leaves.slice(k)));
}

/** Merkle root over raw records, hashing each under `namespace`. */
export function merkleRoot(namespace: string, records: readonly Uint8Array[]): Hash {
  return rootFromLeaves(records.map((r) => hashLeaf(namespace, r)));
}

/**
 * One step of an inclusion proof.
 *
 * `position` says which side the sibling sits on, which is what makes the
 * proof reconstructible without knowing the whole tree. A "sorted pair"
 * scheme that drops direction is smaller but loses the leaf's index, and with
 * it the ability to prove *where* in the ordered set a record sat.
 */
export interface ProofStep {
  position: "left" | "right";
  hash: Hash;
}

/**
 * Inclusion proof for the leaf at `index`.
 *
 * Mirrors rootFromLeaves exactly: descend the same split, record the sibling
 * subtree's root at each level.
 */
export function inclusionProof(leaves: readonly Hash[], index: number): ProofStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`Leaf index ${index} out of range for ${leaves.length} leaves.`);
  }
  if (leaves.length === 1) return [];

  const k = splitPoint(leaves.length);
  if (index < k) {
    // Target is in the left subtree; the right subtree's root is the sibling.
    return [
      ...inclusionProof(leaves.slice(0, k), index),
      { position: "right", hash: rootFromLeaves(leaves.slice(k)) },
    ];
  }
  return [
    ...inclusionProof(leaves.slice(k), index - k),
    { position: "left", hash: rootFromLeaves(leaves.slice(0, k)) },
  ];
}

/**
 * Recompute a root from a leaf and its proof.
 *
 * The verifier's half of the standard, and deliberately the only part a
 * verifier strictly needs: given a leaf hash and the sibling path, there is
 * exactly one root it can produce.
 */
export function rootFromProof(leaf: Hash, proof: readonly ProofStep[]): Hash {
  let current = leaf;
  for (const step of proof) {
    if (step.hash.length !== HASH_BYTES) throw new Error("Proof step hash must be 32 bytes.");
    current = step.position === "left" ? hashNode(step.hash, current) : hashNode(current, step.hash);
  }
  return current;
}

/** Constant-time-ish equality. Not timing-critical here, but free to do right. */
export function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * Verify an inclusion proof against an expected root.
 *
 * `expectedCount` is checked by the caller against the anchor record rather
 * than here: this function proves "this leaf is under this root", and the
 * count is what pins which tree shape produced the root. Both are required —
 * see SPEC.md §3 — and keeping them separate makes it obvious when only one
 * has been done.
 */
export function verifyInclusion(leaf: Hash, proof: readonly ProofStep[], root: Hash): boolean {
  try {
    return hashesEqual(rootFromProof(leaf, proof), root);
  } catch {
    return false;
  }
}

/**
 * Expected proof length for a tree of `count` leaves.
 *
 * Used to reject a proof that has been padded with extra steps. Without this a
 * verifier will happily accept a longer path that still lands on the root by
 * coincidence of construction, which is not a real membership claim.
 */
export function expectedProofLength(count: number, index: number): number {
  if (count <= 1) return 0;
  const k = splitPoint(count);
  return index < k ? expectedProofLength(k, index) + 1 : expectedProofLength(count - k, index - k) + 1;
}
