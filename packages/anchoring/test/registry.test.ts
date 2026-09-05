import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAnchor } from "../src/anchor.js";
import {
  addEntry,
  emptyRegistry,
  queryRegistry,
  summarise,
  validateEntry,
  validateRegistry,
  type RegistryEntry,
} from "../src/registry.js";

const enc = (s: string) => new TextEncoder().encode(s);

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  const tree = buildAnchor("certificates", [enc("a"), enc("b")]);
  return {
    id: "entry-1",
    publisher: "University X",
    description: "Degree certificates 2026",
    anchor: tree.record,
    ledger: { sequence: 55_000_000, txHash: "a".repeat(64), closeTime: "2026-09-05T10:00:00Z" },
    verified: null,
    ...overrides,
  };
}

test("a well-formed entry validates", () => {
  assert.deepEqual(validateEntry(entry()), []);
});

test("an entry is unchecked by default, not verified", () => {
  // The default must not be an assertion of correctness. A publisher adding
  // themselves to a directory has proved nothing.
  assert.equal(entry().verified, null);
});

test("verified, failed and unchecked are counted separately", () => {
  // Collapsing "checked and failed" into "not verified" would let a broken
  // anchor hide among ones nobody has looked at.
  let reg = emptyRegistry();
  reg = addEntry(reg, entry({ id: "ok", verified: { at: "2026-09-05T11:00:00Z", ok: true } }));
  reg = addEntry(reg, entry({ id: "bad", verified: { at: "2026-09-05T11:00:00Z", ok: false } }));
  reg = addEntry(reg, entry({ id: "unknown" }));

  const s = summarise(reg);
  assert.equal(s.total, 3);
  assert.equal(s.verified, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.unchecked, 1);
});

test("malformed entries are refused at insert, not stored and flagged later", () => {
  const reg = emptyRegistry();
  assert.throws(() => addEntry(reg, entry({ publisher: "" })), /publisher/);
  assert.throws(() => addEntry(reg, entry({ ledger: { sequence: 0, txHash: "a".repeat(64), closeTime: "x" } })), /sequence/);
  assert.throws(() => addEntry(reg, entry({ bundlesUrl: "http://insecure.test" })), /https/);
});

test("duplicate ids are rejected", () => {
  let reg = emptyRegistry();
  reg = addEntry(reg, entry({ id: "dup" }));
  assert.throws(() => addEntry(reg, entry({ id: "dup" })), /already exists/);
});

test("addEntry does not mutate the registry it was given", () => {
  const before = emptyRegistry();
  const after = addEntry(before, entry());
  assert.equal(before.entries.length, 0);
  assert.equal(after.entries.length, 1);
});

test("a registry carrying a bad entry reports it with the entry id", () => {
  const reg = emptyRegistry();
  reg.entries.push(entry({ id: "broken", anchor: { ...entry().anchor, root: "nope" } }));
  assert.ok(validateRegistry(reg).some((p) => p.startsWith("broken:")));
});

test("queries filter on publisher, namespace, root, ledger and verification", () => {
  const certs = buildAnchor("certificates", [enc("a")]);
  const invoices = buildAnchor("invoices", [enc("b")]);

  let reg = emptyRegistry();
  reg = addEntry(reg, entry({ id: "1", anchor: certs.record, publisher: "Uni" }));
  reg = addEntry(
    reg,
    entry({
      id: "2",
      anchor: invoices.record,
      publisher: "Corp",
      ledger: { sequence: 56_000_000, txHash: "b".repeat(64), closeTime: "2026-09-06T10:00:00Z" },
      verified: { at: "2026-09-06T11:00:00Z", ok: true },
    }),
  );

  assert.equal(queryRegistry(reg, { publisher: "Uni" }).length, 1);
  assert.equal(queryRegistry(reg, { namespace: "invoices" }).length, 1);
  assert.equal(queryRegistry(reg, { root: certs.record.root }).length, 1);
  assert.equal(queryRegistry(reg, { root: certs.record.root.toUpperCase() }).length, 1);
  assert.equal(queryRegistry(reg, { verifiedOnly: true }).length, 1);
  assert.equal(queryRegistry(reg, { sinceLedger: 56_000_000 }).length, 1);
  assert.equal(queryRegistry(reg).length, 2);
});

test("the registry states it is a directory, not evidence", () => {
  // The note is load-bearing: it is the difference between this design and
  // the notarisation products that make their own database authoritative.
  assert.match(emptyRegistry().note, /not a source of truth/i);
});
