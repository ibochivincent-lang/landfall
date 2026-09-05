import { test } from "node:test";
import assert from "node:assert/strict";

import { consistencyProof, verifyConsistency } from "../src/consistency.js";
import { hashLeaf, rootFromLeaves, type Hash } from "../src/merkle.js";

const enc = (s: string) => new TextEncoder().encode(s);
const NS = "log";

const leavesFor = (n: number): Hash[] =>
  Array.from({ length: n }, (_, i) => hashLeaf(NS, enc(`record-${i}`)));

/* ------------------------------------------------------------------ *
 * The property the whole thing exists for
 * ------------------------------------------------------------------ */

test("SECURITY: a log that removed a record cannot prove consistency", () => {
  // Publisher commits [0,1,2], then republishes with record 1 replaced.
  // Every inclusion proof against the new root still verifies — which is
  // exactly why inclusion proofs alone are not enough.
  const original = leavesFor(3);
  const oldRoot = rootFromLeaves(original);

  const rewritten = [original[0]!, hashLeaf(NS, enc("substituted")), original[2]!, hashLeaf(NS, enc("record-3"))];
  const newRoot = rootFromLeaves(rewritten);

  // The rewriting publisher produces the best proof they can from their tree.
  const forged = consistencyProof(rewritten, 3);
  const result = verifyConsistency(3, 4, oldRoot, newRoot, forged);

  assert.equal(result.consistent, false);
  assert.match(result.reason, /altered or removed/);
});

test("SECURITY: a log cannot shrink", () => {
  const result = verifyConsistency(5, 3, rootFromLeaves(leavesFor(5)), rootFromLeaves(leavesFor(3)), []);
  assert.equal(result.consistent, false);
  assert.match(result.reason, /cannot shrink/);
});

test("SECURITY: same size with a different root is detected as in-place alteration", () => {
  const a = rootFromLeaves(leavesFor(4));
  const b = rootFromLeaves([...leavesFor(3), hashLeaf(NS, enc("different"))]);
  const result = verifyConsistency(4, 4, a, b, []);
  assert.equal(result.consistent, false);
  assert.match(result.reason, /altered in place/);
});

/* ------------------------------------------------------------------ *
 * Exhaustive conformance
 * ------------------------------------------------------------------ */

test("every (old, new) size pair from 1..24 proves and verifies", () => {
  // The algorithm branches on powers of two, odd sizes and the position of the
  // split, so a handful of hand-picked cases would miss the interesting ones.
  for (let newSize = 1; newSize <= 24; newSize++) {
    const leaves = leavesFor(newSize);
    const newRoot = rootFromLeaves(leaves);

    for (let oldSize = 1; oldSize <= newSize; oldSize++) {
      const oldRoot = rootFromLeaves(leaves.slice(0, oldSize));
      const proof = consistencyProof(leaves, oldSize);
      const result = verifyConsistency(oldSize, newSize, oldRoot, newRoot, proof);
      assert.ok(
        result.consistent,
        `consistency ${oldSize} -> ${newSize} failed: ${result.reason}`,
      );
    }
  }
});

test("a proof from one tree does not verify a different tree of the same shape", () => {
  const mine = leavesFor(8);
  const theirs = Array.from({ length: 8 }, (_, i) => hashLeaf(NS, enc(`other-${i}`)));

  const proof = consistencyProof(mine, 3);
  const result = verifyConsistency(
    3,
    8,
    rootFromLeaves(theirs.slice(0, 3)),
    rootFromLeaves(theirs),
    proof,
  );
  assert.equal(result.consistent, false);
});

test("a truncated proof is rejected as incomplete, not accepted", () => {
  const leaves = leavesFor(9);
  const proof = consistencyProof(leaves, 5);
  const result = verifyConsistency(
    5,
    9,
    rootFromLeaves(leaves.slice(0, 5)),
    rootFromLeaves(leaves),
    proof.slice(0, -1),
  );
  assert.equal(result.consistent, false);
});

test("a padded proof is rejected as malformed", () => {
  const leaves = leavesFor(9);
  const proof = consistencyProof(leaves, 5);
  const result = verifyConsistency(5, 9, rootFromLeaves(leaves.slice(0, 5)), rootFromLeaves(leaves), [
    ...proof,
    hashLeaf(NS, enc("extra")),
  ]);
  assert.equal(result.consistent, false);
});

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

test("everything extends the empty tree", () => {
  const result = verifyConsistency(0, 5, rootFromLeaves([]), rootFromLeaves(leavesFor(5)), []);
  assert.equal(result.consistent, true);
});

test("an unchanged log needs no proof", () => {
  const root = rootFromLeaves(leavesFor(6));
  const result = verifyConsistency(6, 6, root, root, []);
  assert.equal(result.consistent, true);
  assert.match(result.reason, /unchanged/);
});

test("a power-of-two old size omits the implicit root and still verifies", () => {
  // The prover omits the old root because the verifier already holds it; a
  // verifier that forgot to reinsert it would fail every power-of-two case.
  for (const oldSize of [1, 2, 4, 8]) {
    const leaves = leavesFor(16);
    const proof = consistencyProof(leaves, oldSize);
    const result = verifyConsistency(
      oldSize,
      16,
      rootFromLeaves(leaves.slice(0, oldSize)),
      rootFromLeaves(leaves),
      proof,
    );
    assert.ok(result.consistent, `power-of-two oldSize=${oldSize} failed: ${result.reason}`);
  }
});

test("growing a log one record at a time stays consistent throughout", () => {
  // The realistic usage pattern: a registry that appends and re-anchors.
  const all = leavesFor(20);
  for (let n = 1; n < 20; n++) {
    const before = all.slice(0, n);
    const after = all.slice(0, n + 1);
    const result = verifyConsistency(
      n,
      n + 1,
      rootFromLeaves(before),
      rootFromLeaves(after),
      consistencyProof(after, n),
    );
    assert.ok(result.consistent, `append ${n} -> ${n + 1} failed: ${result.reason}`);
  }
});

test("an oldSize beyond the tree is refused rather than producing a proof", () => {
  assert.throws(() => consistencyProof(leavesFor(3), 5), /exceeds current tree size/);
  assert.throws(() => consistencyProof(leavesFor(3), -1), /non-negative/);
});
