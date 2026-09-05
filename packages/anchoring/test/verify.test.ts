import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAnchor } from "../src/anchor.js";
import { buildBundle } from "../src/bundle.js";
import { rootToMemo } from "../src/memo.js";
import { verifyBundle, documentMatchesBundle } from "../src/verify.js";
import {
  buildCheckpointBatch,
  proveInCheckpoint,
  toCheckpointProof,
  verifyCheckpointPath,
  NULL_SUBMITTER,
  type CheckpointReceipt,
} from "../src/checkpoint.js";

const enc = (s: string) => new TextEncoder().encode(s);
const NS = "certificates";
const DOCS = ["alice-degree", "bob-degree", "carol-degree"].map(enc);

const TX_HASH = "c".repeat(64);
const LEDGER = { sequence: 55_123_456, closeTime: "2026-09-05T10:00:00Z", txHash: TX_HASH, opIndex: 0 };

/** A Horizon that serves one anchored transaction, and 404s everything else. */
function fakeHorizon(rootHex: string, overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (url: string | URL) => {
    const href = String(url);
    if (!href.includes(TX_HASH)) return new Response("not found", { status: 404 });
    return new Response(
      JSON.stringify({
        hash: TX_HASH,
        ledger: LEDGER.sequence,
        created_at: LEDGER.closeTime,
        memo_type: "hash",
        memo: rootToMemo(rootHex).memoBase64,
        successful: true,
        ...overrides,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

test("a genuine bundle verifies end to end against a Horizon it was not built by", () => {
  // The property that matters: the verifier is handed an arbitrary Horizon and
  // nothing belonging to whoever created the anchor.
  const tree = buildAnchor(NS, DOCS);
  const bundle = buildBundle(tree, 1, LEDGER);

  return verifyBundle(bundle, { fetchImpl: fakeHorizon(tree.record.root), horizon: "https://any-horizon.test" }).then(
    (result) => {
      assert.equal(result.verified, true);
      assert.ok(result.checks.every((c) => c.status === "pass"));
      assert.equal(result.finality?.level, 1);
      assert.equal(result.committedNoLaterThan, LEDGER.closeTime);
    },
  );
});

test("the evidential timestamp comes from the ledger, not the committer's claim", async () => {
  const tree = buildAnchor(NS, DOCS, { timestamp: "2020-01-01T00:00:00Z" });
  const bundle = buildBundle(tree, 0, LEDGER);
  const result = await verifyBundle(bundle, { fetchImpl: fakeHorizon(tree.record.root) });
  assert.equal(result.committedNoLaterThan, LEDGER.closeTime);
  assert.notEqual(result.committedNoLaterThan, tree.record.timestamp);
});

test("a bundle whose memo commits to a different root fails at the commitment check", async () => {
  const tree = buildAnchor(NS, DOCS);
  const other = buildAnchor(NS, [enc("something-else")]);
  const bundle = buildBundle(tree, 0, LEDGER);

  const result = await verifyBundle(bundle, { fetchImpl: fakeHorizon(other.record.root) });
  assert.equal(result.verified, false);
  const memoCheck = result.checks.find((c) => c.id === "memo-commitment");
  assert.equal(memoCheck?.status, "fail");
});

test("a tampered proof fails the arithmetic before any network call", async () => {
  const tree = buildAnchor(NS, DOCS);
  const bundle = buildBundle(tree, 0, LEDGER);
  const tampered = {
    ...bundle,
    proof: bundle.proof.map((s, i) => (i === 0 ? { ...s, hash: "d".repeat(64) } : s)),
  };

  let called = false;
  const spy = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await verifyBundle(tampered, { fetchImpl: spy });
  assert.equal(result.verified, false);
  assert.equal(result.checks.find((c) => c.id === "merkle-root")?.status, "fail");
  assert.equal(called, true, "the ledger is still checked so the report is complete");
});

test("an unreachable Horizon is reported as availability, not as disproof", async () => {
  const tree = buildAnchor(NS, DOCS);
  const bundle = buildBundle(tree, 0, LEDGER);
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  const result = await verifyBundle(bundle, { fetchImpl: down });
  assert.equal(result.verified, false);
  const lookup = result.checks.find((c) => c.id === "ledger-lookup");
  assert.equal(lookup?.status, "fail");
  assert.match(lookup?.detail ?? "", /availability failure, not a disproof/);
  // The arithmetic still passed — the two failures must remain distinguishable.
  assert.equal(result.checks.find((c) => c.id === "merkle-root")?.status, "pass");
});

test("a failed transaction commits nothing", async () => {
  const tree = buildAnchor(NS, DOCS);
  const bundle = buildBundle(tree, 0, LEDGER);
  const result = await verifyBundle(bundle, {
    fetchImpl: fakeHorizon(tree.record.root, { successful: false }),
  });
  assert.equal(result.verified, false);
  assert.equal(result.checks.find((c) => c.id === "tx-successful")?.status, "fail");
});

test("a bundle naming the wrong ledger fails", async () => {
  const tree = buildAnchor(NS, DOCS);
  const bundle = buildBundle(tree, 0, { ...LEDGER, sequence: 1 });
  const result = await verifyBundle(bundle, { fetchImpl: fakeHorizon(tree.record.root) });
  assert.equal(result.checks.find((c) => c.id === "ledger-sequence")?.status, "fail");
});

test("agreeing independent archives raise finality to ARCHIVED", async () => {
  const tree = buildAnchor(NS, DOCS);
  const bundle = buildBundle(tree, 0, LEDGER);
  const result = await verifyBundle(bundle, {
    fetchImpl: fakeHorizon(tree.record.root),
    additionalArchives: ["https://archive-one.test", "https://archive-two.test"],
  });
  assert.equal(result.verified, true);
  assert.equal(result.finality?.level, 2);
  assert.equal(result.finality?.archivesConfirming, 2);
});

test("offline verification proves the arithmetic and refuses to claim more", async () => {
  const tree = buildAnchor(NS, DOCS);
  const bundle = buildBundle(tree, 0, LEDGER);
  const result = await verifyBundle(bundle, { offline: true });

  assert.equal(result.checks.find((c) => c.id === "merkle-root")?.status, "pass");
  assert.equal(result.checks.find((c) => c.id === "ledger-lookup")?.status, "skipped");
  assert.equal(result.verified, false, "arithmetic alone is not verification");
  assert.equal(result.finality, undefined);
});

/* ------------------------------------------------------------------ *
 * Document binding
 * ------------------------------------------------------------------ */

test("the document must be checked separately from the hash", () => {
  const tree = buildAnchor(NS, DOCS);
  const bundle = buildBundle(tree, 1, LEDGER);

  assert.equal(documentMatchesBundle(DOCS[1]!, bundle).matches, true);
  assert.equal(documentMatchesBundle(DOCS[0]!, bundle).matches, false);
  assert.equal(documentMatchesBundle(enc("forged"), bundle).matches, false);
});

test("the right document under the wrong namespace does not match", () => {
  const tree = buildAnchor("certificates", DOCS);
  const bundle = buildBundle(tree, 0, LEDGER);
  const relabelled = { ...bundle, anchor: { ...bundle.anchor, namespace: "invoices" } };
  const check = documentMatchesBundle(DOCS[0]!, relabelled);
  assert.equal(check.matches, false);
  assert.match(check.detail, /different namespace/);
});

/* ------------------------------------------------------------------ *
 * External checkpoints
 * ------------------------------------------------------------------ */

test("an anchor root proves membership of a checkpoint batch", () => {
  const roots = ["a", "b", "c", "d", "e"].map((s) => ({
    root: buildAnchor(NS, [enc(s)]).record.root,
    ledgerSequence: 1000 + s.charCodeAt(0),
    txHash: s.repeat(64).slice(0, 64),
  }));
  const batch = buildCheckpointBatch(roots);

  for (const r of roots) {
    const receipt: CheckpointReceipt = {
      chain: "bitcoin",
      txId: "f".repeat(64),
      blockHeight: 900_000,
      blockTime: "2026-09-05T12:00:00Z",
      submittedAt: "2026-09-05T11:00:00Z",
    };
    const proof = toCheckpointProof(batch, receipt, r.root);
    assert.ok(verifyCheckpointPath(r.root, proof), `root ${r.root.slice(0, 8)} failed its checkpoint path`);
  }
});

test("a root outside the batch cannot be proved into it", () => {
  const batch = buildCheckpointBatch([
    { root: buildAnchor(NS, [enc("a")]).record.root, ledgerSequence: 1, txHash: "1".repeat(64) },
  ]);
  assert.throws(() => proveInCheckpoint(batch, "9".repeat(64)), /not covered/);
});

test("an empty batch is refused", () => {
  assert.throws(() => buildCheckpointBatch([]), /empty batch/);
});

test("checkpoint verification confirms aggregation only, and the check says so", async () => {
  const tree = buildAnchor(NS, DOCS);
  const batch = buildCheckpointBatch([
    { root: tree.record.root, ledgerSequence: LEDGER.sequence, txHash: TX_HASH },
    { root: buildAnchor(NS, [enc("other")]).record.root, ledgerSequence: 2, txHash: "2".repeat(64) },
  ]);
  const proof = toCheckpointProof(
    batch,
    { chain: "bitcoin", txId: "f".repeat(64), blockHeight: 900_000, blockTime: null, submittedAt: "x" },
    tree.record.root,
  );
  const bundle = buildBundle(tree, 0, LEDGER, { checkpoints: [proof] });

  const result = await verifyBundle(bundle, { fetchImpl: fakeHorizon(tree.record.root) });
  const cp = result.checks.find((c) => c.id === "checkpoint-0");
  assert.equal(cp?.status, "pass");
  assert.match(cp?.detail ?? "", /was NOT checked/, "the unverified half must be stated, not implied");
  assert.equal(result.finality?.level, 3);
});

test("the default checkpoint submitter refuses rather than faking a receipt", async () => {
  await assert.rejects(() => NULL_SUBMITTER.submit("a".repeat(64)), /No checkpoint submitter is configured/);
});
