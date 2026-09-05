import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAnchor, proveRecord, validateAnchorRecord, anchorRoot } from "../src/anchor.js";
import { buildBundle, parseBundle, serializeBundle, validateBundleShape } from "../src/bundle.js";
import { rootToMemo, memoToRoot, transactionCommitsTo } from "../src/memo.js";
import { assessFinality } from "../src/finality.js";
import { validateStoragePointer, isPubliclyRetrievable, retrievalUrls } from "../src/storage.js";
import { verifyZkProof, validateZkProof, SUPPORTED_SCHEMES } from "../src/zk.js";

const enc = (s: string) => new TextEncoder().encode(s);
const NS = "certificates";
const RECORDS = ["alice-degree", "bob-degree", "carol-degree", "dave-degree"].map(enc);

const LEDGER = {
  sequence: 55_123_456,
  closeTime: "2026-09-05T10:00:00Z",
  txHash: "a".repeat(64),
  opIndex: 0,
};

/* ------------------------------------------------------------------ *
 * Anchor record
 * ------------------------------------------------------------------ */

test("an anchor commits the record count, pinning tree shape", () => {
  const tree = buildAnchor(NS, RECORDS);
  assert.equal(tree.record.count, 4);
  assert.equal(tree.record.namespace, NS);
  assert.equal(tree.record.algorithm, "sha256-rfc6962");
  assert.match(tree.record.root, /^[0-9a-f]{64}$/);
});

test("anchorRoot matches the tree's root", () => {
  assert.equal(anchorRoot(NS, RECORDS), buildAnchor(NS, RECORDS).record.root);
});

test("an internally inconsistent anchor record is rejected", () => {
  const tree = buildAnchor(NS, RECORDS);
  assert.deepEqual(validateAnchorRecord(tree.record), []);

  assert.ok(validateAnchorRecord({ ...tree.record, version: 99 }).some((p) => /version/.test(p)));
  assert.ok(validateAnchorRecord({ ...tree.record, algorithm: "md5" }).some((p) => /algorithm/i.test(p)));
  assert.ok(validateAnchorRecord({ ...tree.record, root: "nope" }).some((p) => /root/i.test(p)));
  assert.ok(validateAnchorRecord({ ...tree.record, count: -1 }).some((p) => /Count/.test(p)));
  assert.ok(validateAnchorRecord({ ...tree.record, timestamp: "soon" }).some((p) => /[Tt]imestamp/.test(p)));
});

/* ------------------------------------------------------------------ *
 * MEMO_HASH — the no-contract write path
 * ------------------------------------------------------------------ */

test("a root fits MEMO_HASH exactly and round-trips", () => {
  const tree = buildAnchor(NS, RECORDS);
  const memo = rootToMemo(tree.record.root);
  assert.equal(memo.memoType, "hash");
  assert.equal(Buffer.from(memo.memoBase64, "base64").length, 32);
  assert.equal(memoToRoot({ memo_type: "hash", memo: memo.memoBase64 }), tree.record.root);
});

test("a root that is not 32 bytes is refused, never truncated", () => {
  // Silent truncation would still produce a transaction that looked anchored;
  // the failure would only appear years later when a proof did not verify.
  assert.throws(() => rootToMemo("ab".repeat(16)), /exactly 32 bytes/);
});

test("non-hash memos are not mistaken for commitments", () => {
  assert.equal(memoToRoot({ memo_type: "text", memo: "hello" }), null);
  assert.equal(memoToRoot({ memo_type: "none" }), null);
  assert.equal(memoToRoot({}), null);
});

test("transactionCommitsTo matches case-insensitively but not across roots", () => {
  const tree = buildAnchor(NS, RECORDS);
  const memo = rootToMemo(tree.record.root);
  const tx = { memo_type: "hash", memo: memo.memoBase64 };
  assert.ok(transactionCommitsTo(tx, tree.record.root.toUpperCase()));
  assert.ok(!transactionCommitsTo(tx, "f".repeat(64)));
});

/* ------------------------------------------------------------------ *
 * Bundles
 * ------------------------------------------------------------------ */

test("a bundle round-trips through JSON", () => {
  const tree = buildAnchor(NS, RECORDS);
  const bundle = buildBundle(tree, 2, LEDGER);
  const reparsed = parseBundle(serializeBundle(bundle));
  assert.deepEqual(reparsed, bundle);
});

test("a well-formed bundle has no shape problems", () => {
  const tree = buildAnchor(NS, RECORDS);
  assert.deepEqual(validateBundleShape(buildBundle(tree, 0, LEDGER)), []);
});

test("a bundle deliberately does not carry the document", () => {
  const tree = buildAnchor(NS, RECORDS);
  const json = serializeBundle(buildBundle(tree, 0, LEDGER));
  assert.ok(!json.includes("alice-degree"), "the record's plaintext must not appear in the bundle");
});

test("a padded proof is rejected on length, not accepted by luck", () => {
  const tree = buildAnchor(NS, RECORDS);
  const bundle = buildBundle(tree, 0, LEDGER);
  const padded = { ...bundle, proof: [...bundle.proof, { position: "left" as const, hash: "b".repeat(64) }] };
  assert.ok(validateBundleShape(padded).some((p) => /requires exactly/.test(p)));
});

test("an index outside the committed tree is rejected", () => {
  const tree = buildAnchor(NS, RECORDS);
  const bundle = buildBundle(tree, 0, LEDGER);
  const bad = { ...bundle, record: { ...bundle.record, index: 9 } };
  assert.ok(validateBundleShape(bad).some((p) => /outside a tree/.test(p)));
});

test("malformed bundles throw on parse with every problem listed", () => {
  assert.throws(() => parseBundle(JSON.stringify({ version: 1 })), /no anchor record/);
});

test("a bundle for a single-record anchor has an empty proof", () => {
  const tree = buildAnchor(NS, [enc("only")]);
  const bundle = buildBundle(tree, 0, LEDGER);
  assert.deepEqual(bundle.proof, []);
  assert.deepEqual(validateBundleShape(bundle), []);
});

/* ------------------------------------------------------------------ *
 * Finality
 * ------------------------------------------------------------------ */

test("finality levels are ordered and never blended", () => {
  const ledger = assessFinality({ inLedger: true });
  const archived = assessFinality({ inLedger: true, archivesConfirming: 2 });
  const checkpointed = assessFinality({ inLedger: true, archivesConfirming: 2, externalCheckpoints: 1 });

  assert.equal(ledger.level, 1);
  assert.equal(archived.level, 2);
  assert.equal(checkpointed.level, 3);
  assert.ok(ledger.limit.length > 0, "every level must state what it does not assert");
  assert.ok(archived.claim.includes("2"), "the number of confirming archives belongs in the claim");
});

test("finality cannot be assessed for something not in a ledger", () => {
  assert.throws(() => assessFinality({ inLedger: false }), /nothing to grade/);
});

/* ------------------------------------------------------------------ *
 * Storage — a pointer must never be load-bearing
 * ------------------------------------------------------------------ */

test("storage pointers validate by format only", () => {
  assert.deepEqual(validateStoragePointer({ kind: "ipfs", locator: "Qm" + "a".repeat(44) }), []);
  assert.deepEqual(validateStoragePointer({ kind: "none", locator: "" }), []);
  assert.ok(validateStoragePointer({ kind: "ipfs", locator: "not-a-cid" }).length > 0);
  assert.ok(validateStoragePointer({ kind: "https", locator: "http://insecure" }).length > 0);
  assert.ok(validateStoragePointer({ kind: "none", locator: "something" }).length > 0);
});

test("a private anchor with no storage pointer is valid but not retrievable", () => {
  assert.equal(isPubliclyRetrievable({ kind: "none", locator: "" }), false);
  assert.equal(isPubliclyRetrievable(undefined), false);
  assert.equal(isPubliclyRetrievable({ kind: "arweave", locator: "a".repeat(43) }), true);
});

test("content-addressed pointers offer several gateways, none authoritative", () => {
  assert.ok(retrievalUrls({ kind: "ipfs", locator: "Qm" + "a".repeat(44) }).length > 1);
  assert.deepEqual(retrievalUrls({ kind: "none", locator: "" }), []);
});

/* ------------------------------------------------------------------ *
 * ZK — the slot exists, the circuit does not, and it says so
 * ------------------------------------------------------------------ */

test("no ZK scheme is claimed as supported", () => {
  assert.equal(SUPPORTED_SCHEMES.length, 0, "an empty list is the honest state until a circuit is audited");
});

test("an attached ZK proof reports unsupported, not verified, and not failed", () => {
  const result = verifyZkProof({
    scheme: "groth16",
    statement: "membership",
    proof: "AAAA",
    publicInputs: { root: "a".repeat(64) },
    circuitId: "example-v1",
  });
  assert.equal(result.verified, false);
  assert.equal(result.unsupported, true, "unchecked must be distinguishable from disproved");
  assert.match(result.reason, /Merkle path in the same bundle is unaffected/);
});

test("a bundle with no ZK proof is not treated as a ZK failure", () => {
  const result = verifyZkProof(null);
  assert.equal(result.verified, false);
  assert.equal(result.unsupported, false);
});

test("a ZK proof that binds no root is rejected structurally", () => {
  const problems = validateZkProof({
    scheme: "groth16",
    statement: "membership",
    proof: "AAAA",
    publicInputs: {},
    circuitId: "",
  });
  assert.ok(problems.some((p) => /root/.test(p)));
  assert.ok(problems.some((p) => /circuitId/.test(p)));
});
