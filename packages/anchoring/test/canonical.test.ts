import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalBytes, canonicalJson, canonicallyEqual } from "../src/canonical.js";
import { hashLeaf, toHex } from "../src/merkle.js";

/* ------------------------------------------------------------------ *
 * The failure this module exists to prevent
 * ------------------------------------------------------------------ */

test("SECURITY: key order does not change the hash of a record", () => {
  // Without canonicalisation these two hash differently, and a verifier
  // re-serialising with a different library concludes the document was
  // tampered with. The proof would be fine; the encoding would not.
  const a = { name: "Ada", id: 7, active: true };
  const b = { active: true, id: 7, name: "Ada" };

  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(
    toHex(hashLeaf("certs", canonicalBytes(a))),
    toHex(hashLeaf("certs", canonicalBytes(b))),
  );
});

test("nested objects and arrays are canonicalised at every depth", () => {
  const a = { outer: { z: 1, a: [{ y: 2, b: 3 }] } };
  const b = { outer: { a: [{ b: 3, y: 2 }], z: 1 } };
  assert.ok(canonicallyEqual(a, b));
});

test("array order IS significant, unlike key order", () => {
  // Arrays are sequences; reordering them is a different record and must
  // produce a different hash.
  assert.ok(!canonicallyEqual([1, 2, 3], [3, 2, 1]));
});

test("keys sort by UTF-16 code unit, not locale", () => {
  // Locale-aware collation would differ between machines, which is exactly the
  // cross-verifier divergence this module prevents.
  assert.equal(canonicalJson({ b: 1, A: 2, a: 3 }), '{"A":2,"a":3,"b":1}');
});

/* ------------------------------------------------------------------ *
 * Refusals — the values JSON.stringify mangles silently
 * ------------------------------------------------------------------ */

test("NaN and Infinity are refused rather than silently becoming null", () => {
  assert.throws(() => canonicalJson({ v: NaN } as never), /no representation/);
  assert.throws(() => canonicalJson({ v: Infinity } as never), /no representation/);
});

test("undefined is refused rather than silently dropping its key", () => {
  // JSON.stringify({a:1,b:undefined}) === '{"a":1}' — the hash would commit to
  // a record missing a field the author wrote.
  assert.throws(() => canonicalJson({ a: 1, b: undefined } as never), /drop the key/);
});

test("bigint is refused rather than losing precision", () => {
  assert.throws(() => canonicalJson({ v: 10n } as never), /bigint/);
});

test("non-plain objects are refused so representation stays the author's choice", () => {
  assert.throws(() => canonicalJson({ when: new Date() } as never), /non-plain object/);
  assert.throws(() => canonicalJson({ m: new Map() } as never), /non-plain object/);
});

test("the error names the offending path", () => {
  assert.throws(() => canonicalJson({ a: { b: [1, NaN] } } as never), /\$\.a\.b\[1\]/);
});

/* ------------------------------------------------------------------ *
 * Values that are legitimate
 * ------------------------------------------------------------------ */

test("null, empty containers and unicode survive canonicalisation", () => {
  assert.equal(canonicalJson({ a: null, b: {}, c: [] }), '{"a":null,"b":{},"c":[]}');
  assert.equal(canonicalJson({ "key": "café ☕" }), '{"key":"café ☕"}');
});

test("numbers serialise per ECMAScript, which is what RFC 8785 specifies", () => {
  assert.equal(canonicalJson({ a: 1, b: 1.5, c: -0, d: 1e21 }), '{"a":1,"b":1.5,"c":0,"d":1e+21}');
});

test("canonicalBytes round-trips through UTF-8", () => {
  const value = { greeting: "héllo", n: 42 };
  assert.equal(new TextDecoder().decode(canonicalBytes(value)), canonicalJson(value));
});
