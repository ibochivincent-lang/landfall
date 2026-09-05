/**
 * Independent verification (SPEC.md §7).
 *
 * The design constraint that shapes this whole file: **no endpoint belonging
 * to whoever created the anchor may appear in the verification path.** The
 * caller supplies a Horizon URL, and any Horizon or history archive will do,
 * including one they run themselves. If verification required the committer's
 * API, the proof would be worth exactly as much as the committer's continued
 * existence and goodwill, which is nothing.
 *
 * Verification is reported as a list of checks rather than a boolean. A
 * failure at step 2 (the arithmetic does not hold) and a failure at step 3
 * (Horizon is unreachable) mean completely different things — one is a false
 * claim, the other is a network problem — and collapsing them into `false`
 * would let a temporary outage look like fraud.
 */

import { hashesEqual, fromHex, hashLeaf, rootFromProof, toHex, type Hash } from "./merkle.js";
import { transactionCommitsTo } from "./memo.js";
import { assessFinality, type FinalityAssessment } from "./finality.js";
import { verifyCheckpointPath } from "./checkpoint.js";
import { verifyZkProof, type ZkVerificationResult } from "./zk.js";
import {
  bundleProofSteps,
  validateBundleShape,
  type AnchorProofBundle,
} from "./bundle.js";

export interface Check {
  id: string;
  /** What this step establishes, phrased as the claim it proves. */
  claim: string;
  status: "pass" | "fail" | "skipped";
  detail?: string;
}

export interface VerificationResult {
  /** True only when every non-skipped check passed. */
  verified: boolean;
  checks: Check[];
  /** Present when the on-chain checks passed. */
  finality?: FinalityAssessment;
  /** The evidential timestamp — the ledger's, not the committer's. */
  committedNoLaterThan?: string;
  zk: ZkVerificationResult;
}

export interface VerifyOptions {
  /** Any Horizon instance. Default is SDF's, but a self-hosted one is better. */
  horizon?: string;
  /**
   * Additional independent Horizon instances or history archives. Each one
   * that agrees raises finality from LEDGER to ARCHIVED — see SPEC.md §9.
   */
  additionalArchives?: string[];
  fetchImpl?: typeof fetch;
  /** Skip network checks entirely; verifies the arithmetic only. */
  offline?: boolean;
}

const DEFAULT_HORIZON = "https://horizon.stellar.org";

interface HorizonTx {
  hash?: string;
  ledger?: number;
  created_at?: string;
  memo?: string;
  memo_type?: string;
  successful?: boolean;
}

async function fetchTransaction(
  horizon: string,
  txHash: string,
  fetchImpl: typeof fetch,
): Promise<HorizonTx> {
  const url = `${horizon.replace(/\/$/, "")}/transactions/${encodeURIComponent(txHash)}`;
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    // Not necessarily a disproof, and this distinction is the whole reason
    // history archives exist. A Horizon instance serves a retention window,
    // not all history — SDF's public one is explicitly not a full-history
    // node. A ten-year-old anchor will 404 there while being perfectly valid
    // and retrievable from an archive.
    throw new Error(
      `${horizon} has no record of transaction ${txHash}. This may mean the transaction does not exist, ` +
        `or simply that it falls outside this instance's retention window — public Horizon instances do not ` +
        `serve all history. For an older anchor, query a full-history archive before concluding anything.`,
    );
  }
  if (!res.ok) throw new Error(`${horizon} returned HTTP ${res.status} for transaction ${txHash}`);
  return (await res.json()) as HorizonTx;
}

/**
 * Verify a bundle.
 *
 * Steps mirror SPEC.md §7 exactly, in order, and each is reported separately.
 */
export async function verifyBundle(
  bundle: AnchorProofBundle,
  opts: VerifyOptions = {},
): Promise<VerificationResult> {
  const checks: Check[] = [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const horizon = opts.horizon ?? DEFAULT_HORIZON;

  /* ── 0. Shape ─────────────────────────────────────────────────────────── */
  const shapeProblems = validateBundleShape(bundle);
  checks.push({
    id: "bundle-shape",
    claim: "The bundle is well-formed and its proof is the right length for the committed tree.",
    status: shapeProblems.length === 0 ? "pass" : "fail",
    ...(shapeProblems.length ? { detail: shapeProblems.join("; ") } : {}),
  });
  if (shapeProblems.length > 0) {
    return { verified: false, checks, zk: verifyZkProof(bundle.zk) };
  }

  /* ── 1–2. Arithmetic: does the leaf reach the claimed root? ───────────── */
  let recomputed: Hash | null = null;
  try {
    recomputed = rootFromProof(fromHex(bundle.record.hash), bundleProofSteps(bundle));
  } catch (err) {
    checks.push({
      id: "merkle-recompute",
      claim: "The record hash and proof path recompute to a root.",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const rootMatches = recomputed !== null && hashesEqual(recomputed, fromHex(bundle.anchor.root));
  if (recomputed !== null) {
    checks.push({
      id: "merkle-root",
      claim: "The record is included in the anchor's Merkle root.",
      status: rootMatches ? "pass" : "fail",
      ...(rootMatches
        ? {}
        : { detail: "The proof path does not lead to the root this bundle claims. The bundle is not evidence of inclusion." }),
    });
  }

  if (opts.offline) {
    checks.push({
      id: "ledger-lookup",
      claim: "The transaction carrying this root exists on the Stellar ledger.",
      status: "skipped",
      detail: "Offline verification requested — arithmetic only. The on-chain half is unchecked.",
    });
    return {
      verified: false,
      checks,
      zk: verifyZkProof(bundle.zk),
    };
  }

  /* ── 3–5. The ledger half ─────────────────────────────────────────────── */
  let tx: HorizonTx | null = null;
  try {
    tx = await fetchTransaction(horizon, bundle.ledger.txHash, fetchImpl);
    checks.push({
      id: "ledger-lookup",
      claim: "The transaction carrying this root exists on the Stellar ledger.",
      status: "pass",
      detail: `Retrieved from ${horizon}.`,
    });
  } catch (err) {
    checks.push({
      id: "ledger-lookup",
      claim: "The transaction carrying this root exists on the Stellar ledger.",
      status: "fail",
      detail:
        `Could not retrieve it from ${horizon}: ${err instanceof Error ? err.message : String(err)}. ` +
        "This is an availability failure, not a disproof — try another Horizon instance or a history archive.",
    });
  }

  if (tx) {
    const commits = transactionCommitsTo(tx, bundle.anchor.root);
    checks.push({
      id: "memo-commitment",
      claim: "That transaction's MEMO_HASH is the anchor root.",
      status: commits ? "pass" : "fail",
      ...(commits
        ? {}
        : {
            detail:
              `The transaction exists but its memo does not carry this root ` +
              `(memo_type "${tx.memo_type ?? "none"}"). It is not a commitment to this anchor.`,
          }),
    });

    const seqMatches = tx.ledger === bundle.ledger.sequence;
    checks.push({
      id: "ledger-sequence",
      claim: "The transaction is in the ledger the bundle names.",
      status: seqMatches ? "pass" : "fail",
      ...(seqMatches ? {} : { detail: `Bundle says ledger ${bundle.ledger.sequence}; chain says ${tx.ledger}.` }),
    });

    if (tx.successful === false) {
      checks.push({
        id: "tx-successful",
        claim: "The transaction succeeded.",
        status: "fail",
        detail: "A failed transaction is included in a ledger but commits nothing.",
      });
    }
  }

  /* ── Independent archives (finality level 2) ──────────────────────────── */
  let archivesConfirming = 0;
  for (const archive of opts.additionalArchives ?? []) {
    try {
      const other = await fetchTransaction(archive, bundle.ledger.txHash, fetchImpl);
      if (transactionCommitsTo(other, bundle.anchor.root) && other.ledger === bundle.ledger.sequence) {
        archivesConfirming++;
      }
    } catch {
      // An unreachable archive lowers the finality claim rather than failing
      // verification: the commitment is no less valid because one mirror is
      // down, it is simply less demonstrably durable.
    }
  }
  if ((opts.additionalArchives ?? []).length > 0) {
    checks.push({
      id: "independent-archives",
      claim: "The commitment is retrievable from independently operated archives.",
      status: archivesConfirming > 0 ? "pass" : "fail",
      detail: `${archivesConfirming} of ${(opts.additionalArchives ?? []).length} archive(s) agreed.`,
    });
  }

  /* ── External checkpoints (finality level 3) ──────────────────────────── */
  let confirmedCheckpoints = 0;
  for (const [i, cp] of (bundle.checkpoints ?? []).entries()) {
    const pathOk = verifyCheckpointPath(bundle.anchor.root, cp);
    if (pathOk) confirmedCheckpoints++;
    checks.push({
      id: `checkpoint-${i}`,
      claim: `The anchor root is aggregated under a root-of-roots checkpointed to ${cp.chain}.`,
      status: pathOk ? "pass" : "fail",
      detail: pathOk
        ? `Aggregation verified. The ${cp.chain} transaction ${cp.txId} itself was NOT checked — this package ` +
          `does not talk to ${cp.chain}. Confirm it independently before relying on level 3.`
        : "The path from this root to the claimed root-of-roots does not hold.",
    });
  }

  const onChainPassed =
    tx !== null && checks.filter((c) => c.id.startsWith("ledger") || c.id === "memo-commitment").every((c) => c.status === "pass");

  const verified = checks.every((c) => c.status !== "fail");

  const result: VerificationResult = {
    verified,
    checks,
    zk: verifyZkProof(bundle.zk),
  };

  if (onChainPassed && rootMatches) {
    result.finality = assessFinality({
      inLedger: true,
      archivesConfirming,
      externalCheckpoints: confirmedCheckpoints,
    });
    // The ledger's close time, not the committer's claimed timestamp — see
    // SPEC.md §6. Prefer what the chain reports over what the bundle says.
    result.committedNoLaterThan = tx?.created_at ?? bundle.ledger.closeTime;
  }

  return result;
}

/**
 * Verify that a document is the record the bundle proves.
 *
 * Kept separate from `verifyBundle` because they answer different questions.
 * `verifyBundle` proves a *hash* was committed; this proves *this document*
 * produces that hash. A caller who only ever runs the first has proved
 * something true about a number they were handed.
 */
export function documentMatchesBundle(
  document: Uint8Array,
  bundle: AnchorProofBundle,
): { matches: boolean; detail: string } {
  // The namespace matters here and nowhere else in verification: it is bound
  // into the leaf, so hashing under the wrong one silently fails to match.
  const leaf = hashLeaf(bundle.anchor.namespace, document);
  const matches = toHex(leaf).toLowerCase() === bundle.record.hash.toLowerCase();
  return {
    matches,
    detail: matches
      ? `Document hashes to the committed leaf under namespace "${bundle.anchor.namespace}".`
      : `Document does not hash to the committed leaf. Either it is not the anchored record, it has been ` +
        `modified, or it was anchored under a different namespace.`,
  };
}

