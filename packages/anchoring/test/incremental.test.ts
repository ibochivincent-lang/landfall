import { test } from "node:test";
import assert from "node:assert/strict";

import { IncrementalTree, rootFromStream } from "../src/incremental.js";
import { merkleRoot, toHex } from "../src/merkle.js";

const enc = (s: string) => new TextEncoder().encode(s);
const NS = "stream";
const recordsFor = (n: number) => Array.from({ length: n }, (_, i) => enc(`record-${i}`));

/* ------------------------------------------------------------------ *
 * Equivalence with the in-memory builder
 * ------------------------------------------------------------------ */

test("the streaming root equals the in-memory root for every size 0..64", () => {
  // The stack-merge construction reproducing the recursive power-of-two split
  // is not self-evident, so it is checked exhaustively rather than assumed.
  for (let n = 0; n <= 64; n++) {
    const records = recordsFor(n);
    const streamed = new IncrementalTree(NS).appendAll(records).rootHex();
    const inMemory = toHex(merkleRoot(NS, records));
    assert.equal(streamed, inMemory, `size ${n} diverged`);
  }
});

test("appending in several batches gives the same root as one pass", () => {
  const records = recordsFor(23);
  const oneGo = new IncrementalTree(NS).appendAll(records).rootHex();

  const split = new IncrementalTree(NS);
  split.appendAll(records.slice(0, 7));
  split.appendAll(records.slice(7, 19));
  split.appendAll(records.slice(19));

  assert.equal(split.rootHex(), oneGo);
});

/* ------------------------------------------------------------------ *
 * The property that makes it worth having
 * ------------------------------------------------------------------ */

test("memory stays logarithmic — 100k records retain at most 17 hashes", () => {
  const tree = new IncrementalTree(NS);
  for (let i = 0; i < 100_000; i++) tree.append(enc(`r${i}`));

  assert.equal(tree.size, 100_000);
  // ceil(log2(100000)) == 17
  assert.ok(
    tree.retainedHashes <= 17,
    `retained ${tree.retainedHashes} hashes; expected no more than 17`,
  );
});

test("root() is non-destructive, so a log can re-anchor as it grows", () => {
  const tree = new IncrementalTree(NS);
  tree.appendAll(recordsFor(5));
  const atFive = tree.rootHex();

  assert.equal(tree.rootHex(), atFive, "asking twice changed the answer");

  tree.appendAll(recordsFor(3).map((_, i) => enc(`later-${i}`)));
  assert.notEqual(tree.rootHex(), atFive);
  assert.equal(tree.size, 8);
});

test("an empty tree has the empty root and reports size 0", () => {
  const tree = new IncrementalTree(NS);
  assert.equal(tree.size, 0);
  assert.equal(tree.rootHex(), toHex(merkleRoot(NS, [])));
});

/* ------------------------------------------------------------------ *
 * Async streaming
 * ------------------------------------------------------------------ */

test("rootFromStream consumes an async iterable without collecting it", async () => {
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 1000; i++) yield enc(`record-${i}`);
  }
  const { root, count } = await rootFromStream(NS, source());

  assert.equal(count, 1000);
  assert.equal(root, toHex(merkleRoot(NS, recordsFor(1000))));
});

/* ------------------------------------------------------------------ *
 * Namespace binding is preserved
 * ------------------------------------------------------------------ */

test("the same records under different namespaces produce different roots", () => {
  const records = recordsFor(6);
  const a = new IncrementalTree("certificates").appendAll(records).rootHex();
  const b = new IncrementalTree("invoices").appendAll(records).rootHex();
  assert.notEqual(a, b);
});

test("a namespace with a NUL byte is refused", () => {
  assert.throws(() => new IncrementalTree(`bad${String.fromCharCode(0)}ns`), /NUL byte/);
  assert.throws(() => new IncrementalTree("  "), /Namespace is required/);
});
