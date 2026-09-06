/**
 * Guards the routing table in api/[...path].js against one specific,
 * twice-committed mistake: a POST route defined *below* the blanket
 * "GET only" guard, which makes it return 405 no matter what it contains.
 *
 * That is not hypothetical, and it is not a one-off.
 * POST /api/v1/fiat-confirmations shipped, was documented, was unit-tested,
 * and returned 405 in production from the day it landed. Two more write
 * routes were later added below the same line and inherited the fault. A
 * first version of this test was written to stop it happening again — and
 * then the dispute route was added and slipped past it anyway, because that
 * version modelled a route as `v1/<parts[1]>` and could not express a
 * four-segment path like v1/fraud-reports/:id/dispute.
 *
 * So this version does not pattern-match route shapes. It reconstructs the
 * actual `joined` string each route would see at runtime — reading the
 * `parts.length` and `parts[i] === '...'` constraints out of the source —
 * and then asks the guard's own allow-set and patterns whether that string
 * would be let through. If the answer is no, the route is unreachable, and
 * this fails.
 *
 *   node --test api/_lib/routes.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(__dirname, "..", "[...path].js"), "utf8");

/** The exact `joined` values the guard admits for POST. */
function allowedExact() {
  const m = SOURCE.match(/const POST_ROUTES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "POST_ROUTES allow-set not found — did the guard get rewritten?");
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

/** The regexes the guard admits for parameterised POST paths. */
function allowedPatterns() {
  const m = SOURCE.match(/const POST_ROUTE_PATTERNS = \[([\s\S]*?)\];/);
  if (!m) return [];
  return [...m[1].matchAll(/\/(.+?)\/[gimsuy]*\s*(?:,|$)/g)].map((x) => new RegExp(x[1]));
}

/**
 * Every POST route in the file, reconstructed as the `joined` path it would
 * actually match at runtime.
 *
 * Reads each route's own guard conditions: `joined === 'x'` is taken
 * literally; otherwise `parts.length === N` plus any `parts[i] === 'lit'`
 * pins the known segments, and unknown segments become "1" — numeric
 * because the ids in this API are numeric, and because a pattern requiring
 * \d+ should be satisfied by a realistic sample rather than a placeholder
 * that could never appear.
 */
function declaredPostRoutes() {
  const routes = [];
  const lines = SOURCE.split("\n");

  for (const line of lines) {
    if (!line.includes("req.method === 'POST'")) continue;

    const joinedMatch = line.match(/joined === '([^']+)'/);
    if (joinedMatch) {
      routes.push({ path: joinedMatch[1], source: line.trim().slice(0, 90) });
      continue;
    }

    const lengthMatch = line.match(/parts\.length === (\d+)/);
    if (!lengthMatch) continue;
    const length = Number(lengthMatch[1]);

    const segments = new Array(length).fill("1");
    for (const seg of line.matchAll(/parts\[(\d+)\] === '([^']+)'/g)) {
      segments[Number(seg[1])] = seg[2];
    }
    routes.push({ path: segments.join("/"), source: line.trim().slice(0, 90) });
  }

  return routes;
}

function isAllowed(path, exact, patterns) {
  return exact.has(path) || patterns.some((re) => re.test(path));
}

test("every POST route is reachable through the GET-only guard", () => {
  const exact = allowedExact();
  const patterns = allowedPatterns();
  const declared = declaredPostRoutes();

  assert.ok(declared.length > 0, "no POST routes found — the scraper is broken, not the file");

  const stranded = declared.filter((r) => !isAllowed(r.path, exact, patterns));
  assert.deepEqual(
    stranded.map((r) => r.path),
    [],
    "These POST routes sit below the GET-only guard and will return 405 in production:\n" +
      stranded.map((r) => `  ${r.path}\n    from: ${r.source}`).join("\n") +
      "\nAdd them to POST_ROUTES or POST_ROUTE_PATTERNS in api/[...path].js.",
  );
});

test("the guard's exact allow-set has no entries for routes that no longer exist", () => {
  const exact = allowedExact();
  const declared = new Set(declaredPostRoutes().map((r) => r.path));

  const orphaned = [...exact].filter((r) => !declared.has(r));
  assert.deepEqual(
    orphaned,
    [],
    `POST_ROUTES lists routes with no matching handler: ${orphaned.join(", ")}. Remove them, or the guard ` +
      "advertises a write path that falls through to a 404.",
  );
});

test("every parameterised pattern is used by at least one real route", () => {
  const patterns = allowedPatterns();
  const declared = declaredPostRoutes().map((r) => r.path);

  const unused = patterns.filter((re) => !declared.some((p) => re.test(p)));
  assert.deepEqual(
    unused.map(String),
    [],
    "POST_ROUTE_PATTERNS contains a pattern no route matches — either the route was removed, or the " +
      "pattern is wrong and is silently admitting nothing.",
  );
});

test("the routes this test exists for are specifically covered", () => {
  const exact = allowedExact();
  const patterns = allowedPatterns();

  for (const route of [
    "v1/fiat-confirmations",
    "v1/fraud-reports",
    "v1/intent",
    "v1/fraud-reports/42/dispute",
  ]) {
    assert.ok(
      isAllowed(route, exact, patterns),
      `${route} must be reachable by POST — routes like this have returned 405 in production twice already`,
    );
  }
});
