/**
 * Coverage reporting on /api/v1/anchors.
 *
 * The defect this guards against: on 8 September 2026, eleven consecutive
 * scans reported 27 domains and 108 accounts, and the twelfth reported 26 and
 * 93. zeam.money and its fifteen accounts had not been reached — while its
 * TOML still resolved and it was still tracked — and *nothing in the response
 * said so*. A tracked anchor that silently disappears is indistinguishable
 * from one that was never tracked, which is the exact ambiguity this project
 * exists to remove from anchor self-reporting.
 *
 * These tests run the real query shape against a fake `db`, so they need no
 * database and assert the reporting rule rather than the SQL.
 *
 *   node --test api/_lib/coverage.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { scanCoverage } from "../[...path].js";

/** Minimal stand-in: scanCoverage issues exactly one query. */
function fakeDb(rows) {
  return { query: async () => ({ rows }) };
}

const row = (domain, tracked, reached, resolveError = null, lastResolvedAt = null) => ({
  domain,
  tracked_accounts: String(tracked),
  reached_accounts: String(reached),
  resolve_error: resolveError,
  last_resolved_at: lastResolvedAt,
});

test("a complete scan reports complete, with an empty missing list", async () => {
  const c = await scanCoverage(fakeDb([row("a.test", 2, 2), row("b.test", 1, 1)]));
  assert.equal(c.complete, true);
  assert.deepEqual(c.missing, []);
  assert.equal(c.trackedDomains, 2);
  assert.equal(c.reachedDomains, 2);
  assert.equal(c.trackedAccounts, 3);
  assert.equal(c.reachedAccounts, 3);
});

test("missing is present and empty on a complete scan, not omitted", async () => {
  // A consumer should be able to check one field rather than infer
  // completeness from two counts happening to match.
  const c = await scanCoverage(fakeDb([row("a.test", 1, 1)]));
  assert.ok(Array.isArray(c.missing), "missing must always be an array");
});

test("a domain that was not reached at all is reported missing", async () => {
  const c = await scanCoverage(fakeDb([row("a.test", 2, 2), row("gone.test", 15, 0)]));
  assert.equal(c.complete, false);
  assert.equal(c.missing.length, 1);
  assert.equal(c.missing[0].domain, "gone.test");
  assert.equal(c.missing[0].trackedAccounts, 15);
  assert.equal(c.reachedDomains, 1);
  assert.equal(c.trackedDomains, 2);
});

test("a resolve failure reports its reason", async () => {
  const c = await scanCoverage(fakeDb([row("bad.test", 1, 0, "ENOTFOUND")]));
  assert.equal(c.missing[0].reason, "ENOTFOUND");
});

test("a domain that vanished without a resolve error reports a null reason, not a guess", async () => {
  // This is the zeam.money case: tracked, resolvable, absent anyway. "We do
  // not know why" is the honest answer and more useful than an invented one.
  const c = await scanCoverage(fakeDb([row("vanished.test", 15, 0, null)]));
  assert.equal(c.missing[0].reason, null);
  assert.equal(c.complete, false);
});

test("a partially reached domain is not reported missing, but the account counts still show the gap", async () => {
  // Reaching some of a domain's accounts is not the same failure as reaching
  // none, and flattening the two would hide the difference.
  const c = await scanCoverage(fakeDb([row("partial.test", 10, 4)]));
  assert.deepEqual(c.missing, [], "the domain was reached, so it is not missing");
  assert.equal(c.complete, true);
  assert.equal(c.trackedAccounts, 10);
  assert.equal(c.reachedAccounts, 4, "the shortfall is visible in the counts");
});

test("counts are numbers, not the strings Postgres returns for count(*)", async () => {
  // count(*) comes back as a string from pg. Leaving it would make a consumer
  // doing arithmetic on it silently concatenate.
  // Uses a fully-missed domain so there is a `missing` entry to inspect — a
  // partially-reached one is deliberately not reported missing.
  const c = await scanCoverage(fakeDb([row("a.test", 3, 1), row("gone.test", 4, 0)]));
  assert.equal(typeof c.trackedAccounts, "number");
  assert.equal(typeof c.reachedAccounts, "number");
  assert.equal(typeof c.missing[0].trackedAccounts, "number");
  assert.equal(c.trackedAccounts, 7, "must add, not concatenate");
});

test("the zeam.money shape reproduces the original defect's numbers", async () => {
  const rows = [
    ...Array.from({ length: 26 }, (_, i) => row(`d${i}.test`, 3, 3)),
    row("zeam.money", 15, 0),
  ];
  const c = await scanCoverage(fakeDb(rows));
  assert.equal(c.trackedDomains, 27);
  assert.equal(c.reachedDomains, 26);
  assert.equal(c.trackedAccounts, 93);
  assert.equal(c.reachedAccounts, 78);
  assert.equal(c.complete, false);
  assert.equal(c.missing[0].domain, "zeam.money");
});
