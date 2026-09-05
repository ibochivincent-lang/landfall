/**
 * Consistency proofs (RFC 6962 §2.1.2) — the other half of a verifiable log.
 *
 * Inclusion proofs answer "was this record committed?". They cannot answer the
 * question that matters when a log grows over time: **"has anything already
 * committed been removed or altered?"**
 *
 * Without this, an anchoring scheme is silently rewritable. A publisher
 * commits [a, b, c], later commits [a, x, c, d], and every inclusion proof
 * issued against the second root verifies perfectly — while `b` has quietly
 * ceased to have ever existed. Anyone holding an old proof for `b` can detect
 * it, but nobody checking only current proofs can, and nobody who was not
 * already watching will ever know.
 *
 * A consistency proof closes that: given root_m (n=m records) and root_n
 * (n>m records), it proves root_n's tree *begins with exactly* the tree that
 * produced root_m. Append-only, provably.
 *
 * This is what makes a registry of anchors meaningfully different from a
 * database that says nice things about itself.
 */

import { hashNode, hashesEqual, rootFromLeaves, type Hash } from "./merkle.js";

/** True when n is a power of two. Used to detect an implicit first node. */
function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Largest power of two strictly less than n. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * RFC 6962 SUBPROOF.
 *
 * `withRoot` carries the specification's boolean `b`: when the sub-tree being
 * described is exactly the old tree, its root is already known to the verifier
 * and is omitted from the proof rather than sent redundantly.
 */
function subproof(m: number, leaves: readonly Hash[], withRoot: boolean): Hash[] {
  const n = leaves.length;

  if (m === n) {
    // The old tree is this whole sub-tree. Its root is either already known
    // to the verifier (omit) or must be supplied (include).
    return withRoot ? [] : [rootFromLeaves(leaves)];
  }

  const k = splitPoint(n);
  if (m <= k) {
    // Old tree lives entirely in the left sub-tree; the right is new.
    return [...subproof(m, leaves.slice(0, k), withRoot), rootFromLeaves(leaves.slice(k))];
  }
  // Old tree spans the split: its left half is complete, recurse into the right.
  return [...subproof(m - k, leaves.slice(k), false), rootFromLeaves(leaves.slice(0, k))];
}

/**
 * Prove that a tree of `oldSize` leaves is a prefix of the tree over `leaves`.
 *
 * The prover needs the *current* leaves only — not the old tree — because the
 * old tree is by definition a prefix of them. That is the property being
 * proved, and it is also why a prover who has rewritten history cannot produce
 * a valid proof: their current leaves no longer contain the old prefix.
 */
export function consistencyProof(leaves: readonly Hash[], oldSize: number): Hash[] {
  const n = leaves.length;
  if (!Number.isInteger(oldSize) || oldSize < 0) throw new Error("oldSize must be a non-negative integer.");
  if (oldSize > n) throw new Error(`oldSize ${oldSize} exceeds current tree size ${n}.`);

  // An empty old tree is consistent with everything and needs no proof; an
  // unchanged tree needs none either.
  if (oldSize === 0 || oldSize === n) return [];

  return subproof(oldSize, leaves, true);
}

export interface ConsistencyResult {
  consistent: boolean;
  /** Why, in terms that distinguish "rewritten" from "malformed". */
  reason: string;
}

/**
 * Verify that `newRoot` extends `oldRoot` without altering anything.
 *
 * Implements RFC 6962's verification directly rather than reconstructing the
 * tree, so a verifier never needs the records — only two roots, two sizes and
 * the proof. That is what lets a third party audit a log they do not have a
 * copy of.
 */
export function verifyConsistency(
  oldSize: number,
  newSize: number,
  oldRoot: Hash,
  newRoot: Hash,
  proof: readonly Hash[],
): ConsistencyResult {
  if (oldSize > newSize) {
    return {
      consistent: false,
      reason: `A log cannot shrink: old size ${oldSize} exceeds new size ${newSize}. Records have been removed.`,
    };
  }
  if (oldSize === 0) {
    // Everything extends the empty tree. Nothing was committed to alter.
    return { consistent: true, reason: "The earlier tree was empty; any tree extends it." };
  }
  if (oldSize === newSize) {
    const same = hashesEqual(oldRoot, newRoot);
    return {
      consistent: same,
      reason: same
        ? "Same size and same root — the log is unchanged."
        : "Same size but a different root: records were altered in place, not appended.",
    };
  }

  // When the old size is a power of two its root is an implicit first element
  // of the proof — the prover omitted it because the verifier already has it.
  const path = isPowerOfTwo(oldSize) ? [oldRoot, ...proof] : [...proof];

  if (path.length === 0) {
    return { consistent: false, reason: "Proof is empty but the log grew; nothing links the two roots." };
  }

  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn & 1) {
    fn >>= 1;
    sn >>= 1;
  }

  let fr = path[0] as Hash;
  let sr = path[0] as Hash;

  for (const step of path.slice(1)) {
    if (sn === 0) {
      return { consistent: false, reason: "Proof is longer than the tree shape allows; it is malformed." };
    }
    if (fn & 1 || fn === sn) {
      fr = hashNode(step, fr);
      sr = hashNode(step, sr);
      while (fn !== 0 && (fn & 1) === 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      sr = hashNode(sr, step);
    }
    fn >>= 1;
    sn >>= 1;
  }

  if (sn !== 0) {
    return { consistent: false, reason: "Proof is shorter than the tree shape requires; it is incomplete." };
  }
  if (!hashesEqual(fr, oldRoot)) {
    return {
      consistent: false,
      reason:
        "The proof does not reconstruct the earlier root. The current log does not begin with the tree that " +
        "was previously published — earlier records have been altered or removed.",
    };
  }
  if (!hashesEqual(sr, newRoot)) {
    return {
      consistent: false,
      reason: "The proof does not reconstruct the current root; the proof does not belong to this tree.",
    };
  }

  return {
    consistent: true,
    reason: `The log of ${newSize} records provably begins with the ${oldSize} records published earlier — append-only.`,
  };
}
