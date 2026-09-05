import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  emptyRoot,
  expectedProofLength,
  fromHex,
  hashLeaf,
  hashNode,
  hashesEqual,
  inclusionProof,
  merkleRoot,
  rootFromLeaves,
  rootFromProof,
  toHex,
  verifyInclusion,
} from "../src/merkle.js";

const enc = (s: string) => new TextEncoder().encode(s);
const NS = "certificates";

/* ------------------------------------------------------------------ *
 * The two attacks this construction exists to prevent
 * ------------------------------------------------------------------ */

test("SECURITY: an internal node cannot be replayed as a leaf", () => {
  // Without the 0x00/0x01 domain prefixes, a record whose bytes happen to be
  // two concatenated hashes would hash to the same value as a real internal
  // node — letting an attacker present a node as a committed record.
  const a = hashLeaf(NS, enc("a"));
  const b = hashLeaf(NS, enc("b"));
  const node = hashNode(a, b);

  const forged = new Uint8Array(a.length + b.length);
  forged.set(a, 0);
  forged.set(b, a.length);

  assert.ok(
    !hashesEqual(hashLeaf(NS, forged), node),
    "a leaf over concatenated child hashes must not equal the internal node over those children",
  );
});

test("SECURITY: a namespace cannot be replayed across scopes", () => {
  const underCerts = hashLeaf("certificates", enc("degree-1"));
  const underInvoices = hashLeaf("invoices", enc("degree-1"));
  assert.ok(!hashesEqual(underCerts, underInvoices), "the same bytes must hash differently per namespace");
});

test("SECURITY: namespace tag is terminated, so adjacent names cannot collide", () => {
  // "cert" + "ificates" must not equal "certificates" + "" once tagged.
  assert.ok(!hashesEqual(hashLeaf("cert", enc("ificates|x")), hashLeaf("certificates", enc("|x"))));
});

test("SECURITY: no two record lists share a root (CVE-2012-2459 shape)", () => {
  // The classic duplication bug: with "duplicate the odd trailing node",
  // [a,b,c] and [a,b,c,c] collide. RFC 6962's split must keep them distinct.
  const three = merkleRoot(NS, [enc("a"), enc("b"), enc("c")]);
  const four = merkleRoot(NS, [enc("a"), enc("b"), enc("c"), enc("c")]);
  assert.ok(!hashesEqual(three, four), "[a,b,c] and [a,b,c,c] must not produce the same root");
});

test("namespace containing a NUL byte is rejected rather than silently truncated", () => {
  assert.throws(() => hashLeaf(`bad${String.fromCharCode(0)}ns`, enc("x")), /NUL/);
});

/* ------------------------------------------------------------------ *
 * RFC 6962 conformance
 * ------------------------------------------------------------------ */

test("empty tree root is the hash of the empty string", () => {
  assert.equal(toHex(emptyRoot()), toHex(sha256(new Uint8Array(0))));
});

test("single-leaf tree root is the leaf itself", () => {
  const leaf = hashLeaf(NS, enc("only"));
  assert.equal(toHex(rootFromLeaves([leaf])), toHex(leaf));
});

test("two-leaf root is node(l, r)", () => {
  const a = hashLeaf(NS, enc("a"));
  const b = hashLeaf(NS, enc("b"));
  assert.equal(toHex(merkleRoot(NS, [enc("a"), enc("b")])), toHex(hashNode(a, b)));
});

test("odd trees split at the largest power of two, not by duplication", () => {
  // n=3 must be node(node(a,b), c), not node(node(a,b), node(c,c)).
  const [a, b, c] = [enc("a"), enc("b"), enc("c")].map((r) => hashLeaf(NS, r));
  const expected = hashNode(hashNode(a!, b!), c!);
  assert.equal(toHex(merkleRoot(NS, [enc("a"), enc("b"), enc("c")])), toHex(expected));
});

test("order is significant — reordering records changes the root", () => {
  const forward = merkleRoot(NS, [enc("a"), enc("b")]);
  const reversed = merkleRoot(NS, [enc("b"), enc("a")]);
  assert.ok(!hashesEqual(forward, reversed));
});

/* ------------------------------------------------------------------ *
 * Proofs
 * ------------------------------------------------------------------ */

test("every leaf in trees of size 1..33 proves against the root", () => {
  // Exercises both sides of every split, including the awkward sizes either
  // side of a power of two where an off-by-one in splitPoint would hide.
  for (let n = 1; n <= 33; n++) {
    const records = Array.from({ length: n }, (_, i) => enc(`record-${i}`));
    const leaves = records.map((r) => hashLeaf(NS, r));
    const root = rootFromLeaves(leaves);

    for (let i = 0; i < n; i++) {
      const proof = inclusionProof(leaves, i);
      assert.ok(verifyInclusion(leaves[i]!, proof, root), `n=${n} index=${i} failed to verify`);
      assert.equal(proof.length, expectedProofLength(n, i), `n=${n} index=${i} unexpected proof length`);
    }
  }
});

test("a proof for one leaf does not verify another leaf", () => {
  const records = [enc("a"), enc("b"), enc("c"), enc("d")];
  const leaves = records.map((r) => hashLeaf(NS, r));
  const root = rootFromLeaves(leaves);
  const proofFor0 = inclusionProof(leaves, 0);
  assert.ok(!verifyInclusion(leaves[1]!, proofFor0, root));
});

test("a tampered proof step fails", () => {
  const records = [enc("a"), enc("b"), enc("c"), enc("d")];
  const leaves = records.map((r) => hashLeaf(NS, r));
  const root = rootFromLeaves(leaves);
  const proof = inclusionProof(leaves, 2);
  const tampered = proof.map((s, i) => (i === 0 ? { ...s, hash: hashLeaf(NS, enc("evil")) } : s));
  assert.ok(!verifyInclusion(leaves[2]!, tampered, root));
});

test("flipping a proof step's direction fails", () => {
  const records = [enc("a"), enc("b"), enc("c")];
  const leaves = records.map((r) => hashLeaf(NS, r));
  const root = rootFromLeaves(leaves);
  const proof = inclusionProof(leaves, 0);
  const flipped = proof.map((s) => ({ ...s, position: s.position === "left" ? ("right" as const) : ("left" as const) }));
  assert.ok(!verifyInclusion(leaves[0]!, flipped, root));
});

test("a record not in the set does not verify", () => {
  const leaves = [enc("a"), enc("b")].map((r) => hashLeaf(NS, r));
  const root = rootFromLeaves(leaves);
  assert.ok(!verifyInclusion(hashLeaf(NS, enc("never-committed")), inclusionProof(leaves, 0), root));
});

test("an out-of-range index is rejected rather than returning a bogus proof", () => {
  const leaves = [enc("a"), enc("b")].map((r) => hashLeaf(NS, r));
  assert.throws(() => inclusionProof(leaves, 2), /out of range/);
  assert.throws(() => inclusionProof(leaves, -1), /out of range/);
});

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

test("hex round-trips and rejects malformed input", () => {
  const bytes = hashLeaf(NS, enc("x"));
  assert.ok(hashesEqual(fromHex(toHex(bytes)), bytes));
  assert.ok(hashesEqual(fromHex("0x" + toHex(bytes)), bytes));
  assert.throws(() => fromHex("abc"), /odd length/);
  assert.throws(() => fromHex("zz"), /Not hex/);
});

test("rootFromProof rejects a step that is not 32 bytes", () => {
  assert.throws(
    () => rootFromProof(hashLeaf(NS, enc("a")), [{ position: "left", hash: new Uint8Array(31) }]),
    /32 bytes/,
  );
});
