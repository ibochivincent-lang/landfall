/**
 * The anchor proof bundle (SPEC.md §7) — the unit that has to survive.
 *
 * Everything a verifier needs *except the Stellar ledger itself*. That
 * exception is the whole design: the bundle deliberately does not carry a
 * signature, an issuer identity, or an API endpoint, because none of those
 * would help a sceptic ten years from now. What it carries is arithmetic that
 * can be redone and a ledger coordinate that can be looked up in any archive.
 *
 * A bundle is plain JSON on purpose. It should still be readable when this
 * package, its language, and the company that produced it are all gone.
 */

import {
  expectedProofLength,
  fromHex,
  inclusionProof,
  toHex,
  type Hash,
  type ProofStep,
} from "./merkle.js";
import { ANCHOR_ALGORITHM, ANCHOR_VERSION, type AnchorRecord, type AnchorTree } from "./anchor.js";
import type { CheckpointProof } from "./checkpoint.js";
import type { StoragePointer } from "./storage.js";
import type { ZkProof } from "./zk.js";

export const BUNDLE_VERSION = 1;

/** Where on the Stellar ledger the commitment landed (SPEC.md §6). */
export interface LedgerCoordinate {
  sequence: number;
  /** RFC 3339. The validator-agreed close time — this is the evidential timestamp. */
  closeTime: string;
  txHash: string;
  opIndex: number;
}

export interface AnchorProofBundle {
  version: number;
  anchor: AnchorRecord;
  record: {
    /** Position in the ordered record set. */
    index: number;
    /** Leaf hash — hex. The document itself is deliberately not included. */
    hash: string;
  };
  proof: Array<{ position: "left" | "right"; hash: string }>;
  ledger: LedgerCoordinate;
  storage?: StoragePointer;
  checkpoints?: CheckpointProof[];
  zk?: ZkProof | null;
}

/**
 * Assemble a bundle for one record in a built tree.
 *
 * The ledger coordinate is supplied by the caller rather than looked up,
 * because building a bundle should not require a network. A bundle whose
 * coordinate is wrong fails verification at step 4 anyway.
 */
export function buildBundle(
  tree: AnchorTree,
  index: number,
  ledger: LedgerCoordinate,
  extras: {
    storage?: StoragePointer;
    checkpoints?: CheckpointProof[];
    zk?: ZkProof | null;
    proof?: ProofStep[];
  } = {},
): AnchorProofBundle {
  const leaf = tree.leaves[index];
  if (!leaf) throw new Error(`No leaf at index ${index} (tree has ${tree.leaves.length}).`);

  // Allow a caller to pass a proof they already computed — a large tree may be
  // proved once and discarded rather than held in memory per bundle.
  const steps = extras.proof ?? inclusionProof(tree.leaves, index);

  return {
    version: BUNDLE_VERSION,
    anchor: tree.record,
    record: { index, hash: toHex(leaf) },
    proof: steps.map((s) => ({ position: s.position, hash: toHex(s.hash) })),
    ledger,
    ...(extras.storage ? { storage: extras.storage } : {}),
    ...(extras.checkpoints?.length ? { checkpoints: extras.checkpoints } : {}),
    zk: extras.zk ?? null,
  };
}

/**
 * Structural validation, before any cryptography.
 *
 * Separated from verification so a caller can tell "this bundle is malformed"
 * from "this bundle is well-formed and the proof does not hold". Those warrant
 * very different reactions — the first is a broken producer, the second is a
 * failed claim.
 */
export function validateBundleShape(bundle: AnchorProofBundle): string[] {
  const problems: string[] = [];

  if (bundle.version !== BUNDLE_VERSION) {
    problems.push(`Unsupported bundle version ${bundle.version} (this implementation speaks ${BUNDLE_VERSION}).`);
  }
  if (!bundle.anchor) {
    problems.push("Bundle carries no anchor record.");
    return problems; // everything below depends on it
  }
  if (bundle.anchor.version !== ANCHOR_VERSION) {
    problems.push(`Unsupported anchor version ${bundle.anchor.version}.`);
  }
  if (bundle.anchor.algorithm !== ANCHOR_ALGORITHM) {
    problems.push(`Unsupported algorithm "${bundle.anchor.algorithm}".`);
  }
  if (!/^[0-9a-f]{64}$/i.test(bundle.anchor.root ?? "")) {
    problems.push("Anchor root is not a 32-byte hex digest.");
  }
  if (!/^[0-9a-f]{64}$/i.test(bundle.record?.hash ?? "")) {
    problems.push("Record hash is not a 32-byte hex digest.");
  }
  if (!Number.isInteger(bundle.record?.index) || bundle.record.index < 0) {
    problems.push("Record index must be a non-negative integer.");
  }
  if (Number.isInteger(bundle.anchor.count) && bundle.record?.index >= bundle.anchor.count) {
    problems.push(`Record index ${bundle.record.index} is outside a tree of ${bundle.anchor.count} records.`);
  }
  if (!Array.isArray(bundle.proof)) {
    problems.push("Bundle carries no proof path.");
  } else {
    for (const [i, step] of bundle.proof.entries()) {
      if (step.position !== "left" && step.position !== "right") {
        problems.push(`Proof step ${i} has an invalid position "${String(step.position)}".`);
      }
      if (!/^[0-9a-f]{64}$/i.test(step.hash ?? "")) {
        problems.push(`Proof step ${i} hash is not a 32-byte hex digest.`);
      }
    }
    // A padded path can still land on the root by construction; the tree shape
    // fixes exactly how many steps there should be, so anything else is a
    // malformed claim rather than a merely unlucky one.
    if (Number.isInteger(bundle.anchor.count) && bundle.anchor.count > 0) {
      const expected = expectedProofLength(bundle.anchor.count, bundle.record.index);
      if (bundle.proof.length !== expected) {
        problems.push(
          `Proof has ${bundle.proof.length} step(s); a tree of ${bundle.anchor.count} records requires exactly ` +
            `${expected} for index ${bundle.record.index}.`,
        );
      }
    }
  }
  if (!bundle.ledger) {
    problems.push("Bundle carries no ledger coordinate, so there is nothing to check it against.");
  } else {
    if (!Number.isInteger(bundle.ledger.sequence) || bundle.ledger.sequence <= 0) {
      problems.push("Ledger sequence must be a positive integer.");
    }
    if (!/^[0-9a-f]{64}$/i.test(bundle.ledger.txHash ?? "")) {
      problems.push("Ledger txHash is not a 32-byte hex digest.");
    }
    if (Number.isNaN(Date.parse(bundle.ledger.closeTime ?? ""))) {
      problems.push("Ledger closeTime is not a parseable date.");
    }
  }
  return problems;
}

/** Bundle → JSON, stable key order, suitable for writing to a file. */
export function serializeBundle(bundle: AnchorProofBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

/** JSON → bundle, with shape validation applied. Throws on malformed input. */
export function parseBundle(json: string): AnchorProofBundle {
  const parsed = JSON.parse(json) as AnchorProofBundle;
  const problems = validateBundleShape(parsed);
  if (problems.length > 0) {
    throw new Error(`Malformed anchor proof bundle:\n  - ${problems.join("\n  - ")}`);
  }
  return parsed;
}

/** Proof steps in the form the merkle module wants. */
export function bundleProofSteps(bundle: AnchorProofBundle): ProofStep[] {
  return bundle.proof.map((s) => ({ position: s.position, hash: fromHex(s.hash) as Hash }));
}
