/**
 * External checkpoints (SPEC.md §9.1).
 *
 * Many Stellar roots are aggregated into a root-of-roots, which is committed
 * to a chain with different security assumptions — typically Bitcoin. A bundle
 * then carries a second proof path from its own root up to that checkpoint, so
 * rewriting the history requires attacking both chains rather than one.
 *
 *   anchor roots ──► root-of-roots ──► external chain
 *
 * The aggregation and the proof format are implemented here. **Submission is
 * not**, and the interface below is why: actually writing to Bitcoin needs
 * funds, key custody, fee management and an operational commitment that
 * continues for as long as anyone might want to verify. A library cannot make
 * that commitment on a caller's behalf, and one that pretended to — by
 * fabricating a checkpoint, or by returning success from a stub — would
 * produce bundles claiming a level-3 finality that does not exist.
 *
 * So `CheckpointSubmitter` is an interface, `NULL_SUBMITTER` refuses, and a
 * bundle without a real submission reports level 1 or 2 and says so.
 *
 * Anyone building the submission side should read OpenTimestamps first. It has
 * done exactly this since 2016, for free, and the reason to reimplement it
 * would need to be a good one.
 */

import { hashNode, inclusionProof, rootFromLeaves, fromHex, toHex, type Hash, type ProofStep } from "./merkle.js";

/** A Stellar anchor root awaiting checkpoint, with where it was committed. */
export interface PendingRoot {
  /** Hex root of the Stellar anchor. */
  root: string;
  /** Stellar ledger the anchor was committed in. */
  ledgerSequence: number;
  /** Stellar transaction carrying the memo. */
  txHash: string;
}

/** The aggregate submitted to an external chain. */
export interface CheckpointBatch {
  /** Hex root-of-roots over every included anchor root, in order. */
  rootOfRoots: string;
  /** The anchor roots covered, in the order they were aggregated. */
  covered: PendingRoot[];
  /** When the batch was formed. */
  createdAt: string;
}

/** Where a batch ended up, once a submitter has actually written it. */
export interface CheckpointReceipt {
  chain: "bitcoin" | "ethereum" | string;
  /** Transaction id on the external chain. */
  txId: string;
  /** Block height/number, once known. Null while unconfirmed. */
  blockHeight: number | null;
  /** External chain's own timestamp for that block, once known. */
  blockTime: string | null;
  submittedAt: string;
}

/** The proof path from one anchor root up to a checkpointed root-of-roots. */
export interface CheckpointProof {
  chain: string;
  txId: string;
  blockHeight: number | null;
  blockTime: string | null;
  rootOfRoots: string;
  /** Sibling path from this anchor's root to the root-of-roots. */
  path: Array<{ position: "left" | "right"; hash: string }>;
}

/**
 * Aggregate pending anchor roots into one root-of-roots.
 *
 * The roots are treated as opaque 32-byte leaves and hashed with the same
 * RFC 6962 construction used one level down, so the same verifier arithmetic
 * works for both levels. Order is preserved and is part of the commitment.
 */
export function buildCheckpointBatch(pending: readonly PendingRoot[], createdAt?: string): CheckpointBatch {
  if (pending.length === 0) throw new Error("Cannot checkpoint an empty batch.");

  const leaves: Hash[] = pending.map((p) => {
    const bytes = fromHex(p.root);
    if (bytes.length !== 32) throw new Error(`Anchor root ${p.root} is not 32 bytes.`);
    return bytes;
  });

  return {
    rootOfRoots: toHex(rootFromLeaves(leaves)),
    covered: [...pending],
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

/**
 * The proof path for one anchor root within a batch.
 *
 * Note the leaves here are the roots themselves, not `hashLeaf`-wrapped: at
 * this level the inputs are already domain-separated 32-byte digests produced
 * by the layer below, and re-wrapping them would mean a verifier needed to
 * know a second namespace to check a checkpoint.
 */
export function proveInCheckpoint(batch: CheckpointBatch, anchorRootHex: string): ProofStep[] {
  const index = batch.covered.findIndex((p) => p.root.toLowerCase() === anchorRootHex.toLowerCase());
  if (index === -1) throw new Error(`Root ${anchorRootHex} is not covered by this batch.`);
  return inclusionProof(batch.covered.map((p) => fromHex(p.root)), index);
}

/** Serialise a proof path plus receipt into the form a bundle carries. */
export function toCheckpointProof(
  batch: CheckpointBatch,
  receipt: CheckpointReceipt,
  anchorRootHex: string,
): CheckpointProof {
  return {
    chain: receipt.chain,
    txId: receipt.txId,
    blockHeight: receipt.blockHeight,
    blockTime: receipt.blockTime,
    rootOfRoots: batch.rootOfRoots,
    path: proveInCheckpoint(batch, anchorRootHex).map((s) => ({ position: s.position, hash: toHex(s.hash) })),
  };
}

/**
 * Writes a root-of-roots to some external chain.
 *
 * Implementations own funds and keys. Nothing in this package provides one,
 * and that is the honest state of item 8: the format and the aggregation are
 * done, the operational half is a commitment somebody has to actually make.
 */
export interface CheckpointSubmitter {
  readonly chain: string;
  submit(rootOfRoots: string): Promise<CheckpointReceipt>;
}

/**
 * The default submitter, which refuses.
 *
 * Mirrors NULL_FIAT_LEG_BINDER in the settlement adapters, for the same
 * reason: a stub that returned a plausible-looking receipt would let a bundle
 * assert an external checkpoint nobody made. Refusing loudly is the only
 * behaviour that cannot become a false claim.
 */
export const NULL_SUBMITTER: CheckpointSubmitter = {
  chain: "none",
  async submit(): Promise<CheckpointReceipt> {
    throw new Error(
      "No checkpoint submitter is configured. Writing a root-of-roots to an external chain requires funds, " +
        "keys and ongoing operation, none of which this package provides. Supply a CheckpointSubmitter, or " +
        "use OpenTimestamps, which has done this since 2016. Until then bundles correctly report finality " +
        "level 1 or 2 rather than claiming a checkpoint that was never made.",
    );
  },
};

/**
 * Verify that an anchor root really sits under a checkpointed root-of-roots.
 *
 * This confirms the *aggregation* only. Whether the external transaction
 * exists, is confirmed, and actually contains this root-of-roots must be
 * checked against that chain — which this package does not talk to. A caller
 * that skips the second half has verified arithmetic, not a checkpoint, and
 * `verifyCheckpointPath` is named narrowly to make that hard to forget.
 */
export function verifyCheckpointPath(anchorRootHex: string, proof: CheckpointProof): boolean {
  try {
    let current = fromHex(anchorRootHex);
    if (current.length !== 32) return false;

    for (const step of proof.path) {
      const sibling = fromHex(step.hash);
      if (sibling.length !== 32) return false;
      current = step.position === "left" ? hashNode(sibling, current) : hashNode(current, sibling);
    }
    return toHex(current).toLowerCase() === proof.rootOfRoots.toLowerCase();
  } catch {
    return false;
  }
}
