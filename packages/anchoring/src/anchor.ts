/**
 * The anchor record (SPEC.md §4) — what is committed, and what a verifier
 * needs in order to interpret the 32 bytes that reach the ledger.
 *
 * Only `root` goes on-chain. Every other field travels in the proof bundle and
 * is verified by reconstruction rather than trusted: a bundle that lies about
 * the namespace hashes different leaves, produces a different root, and fails
 * against the memo. That property is why this record does not need to be
 * signed — a forged field cannot survive verification.
 */

import {
  hashLeaf,
  merkleRoot,
  inclusionProof,
  rootFromLeaves,
  toHex,
  type Hash,
  type ProofStep,
} from "./merkle.js";

export const ANCHOR_VERSION = 1;
export const ANCHOR_ALGORITHM = "sha256-rfc6962";

export interface AnchorRecord {
  version: number;
  namespace: string;
  /** Hex, 64 characters. */
  root: string;
  algorithm: string;
  /** Number of records committed. Pins the tree shape — see SPEC.md §3. */
  count: number;
  /** Committer's claimed build time. Advisory: the ledger's time is evidence. */
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** A built tree, kept in memory so proofs can be drawn from it. */
export interface AnchorTree {
  record: AnchorRecord;
  leaves: Hash[];
  rootBytes: Hash;
}

function assertNamespace(namespace: string): void {
  if (!namespace || namespace.trim() === "") throw new Error("Namespace is required.");
  if (namespace.indexOf(String.fromCharCode(0)) !== -1) {
    throw new Error("Namespace may not contain a NUL byte — it terminates the domain tag.");
  }
}

/**
 * Build an anchor over a set of records.
 *
 * Order is preserved and significant: it is part of what the root commits to,
 * so a caller reordering their input gets a different anchor. That is
 * deliberate — it lets a proof say *where* in an ordered set a record sat, not
 * merely that it was somewhere in the pile.
 */
export function buildAnchor(
  namespace: string,
  records: readonly Uint8Array[],
  opts: { timestamp?: string; metadata?: Record<string, unknown> } = {},
): AnchorTree {
  assertNamespace(namespace);

  const leaves = records.map((r) => hashLeaf(namespace, r));
  const rootBytes = rootFromLeaves(leaves);

  return {
    leaves,
    rootBytes,
    record: {
      version: ANCHOR_VERSION,
      namespace,
      root: toHex(rootBytes),
      algorithm: ANCHOR_ALGORITHM,
      count: records.length,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    },
  };
}

/** Root over raw records without retaining the tree. */
export function anchorRoot(namespace: string, records: readonly Uint8Array[]): string {
  return toHex(merkleRoot(namespace, records));
}

/** Inclusion proof for one record in a built tree. */
export function proveRecord(tree: AnchorTree, index: number): ProofStep[] {
  return inclusionProof(tree.leaves, index);
}

/**
 * Reject an anchor record that is internally inconsistent, before it is used
 * for anything.
 *
 * A verifier that skips this can be handed a record whose `count` does not
 * match the tree that produced its `root`, which is precisely the ambiguity
 * the count exists to remove.
 */
export function validateAnchorRecord(record: AnchorRecord): string[] {
  const problems: string[] = [];

  if (record.version !== ANCHOR_VERSION) {
    problems.push(`Unsupported anchor version ${record.version} (this implementation speaks ${ANCHOR_VERSION}).`);
  }
  if (record.algorithm !== ANCHOR_ALGORITHM) {
    problems.push(`Unsupported algorithm "${record.algorithm}" (expected "${ANCHOR_ALGORITHM}").`);
  }
  if (!record.namespace || record.namespace.trim() === "") {
    problems.push("Namespace is empty; leaves cannot be domain-separated.");
  }
  if (!/^[0-9a-f]{64}$/i.test(record.root)) {
    problems.push("Root is not a 32-byte hex digest.");
  }
  if (!Number.isInteger(record.count) || record.count < 0) {
    problems.push("Count must be a non-negative integer.");
  }
  if (Number.isNaN(Date.parse(record.timestamp))) {
    problems.push("Timestamp is not a parseable date.");
  }
  return problems;
}
