/**
 * Guards the routing table in api/[...path].js against one specific,
 * already-committed mistake: a POST route defined *below* the blanket
 * "GET only" guard, which makes it return 405 no matter what it contains.
 *
 * That is not hypothetical. POST /api/v1/fiat-confirmations shipped, was
 * documented, was unit-tested, and returned 405 in production from the day
 * it landed, because the guard sat above it. Two more write routes were
 * later added below the same line and inherited the same fault. Nothing
 * caught it: the routes' own logic was tested in isolation, and a 405 on a
 * documented path reads like a platform quirk rather than a bug in this
 * file.
 *
 * So this test reads the source and checks the two facts that failed:
 * that every POST route is listed in the guard's allow-set, and that the
 * allow-set contains nothing that no longer exists.
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

/** The `joined` paths the guard lets through for POST. */
function allowedPostRoutes() {
  const m = SOURCE.match(/const POST_ROUTES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "POST_ROUTES allow-set not found — did the guard get rewritten?");
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

/**
 * Every `joined === 'v1/...'` compared under a POST method check. Deliberately
 * source-scraping rather than importing: the bug being guarded against is
 * about where a route sits in the file, which only the text can show.
 */
function declaredPostRoutes() {
  const routes = new Set();
  // if (req.method === 'POST' && joined === 'v1/thing')
  for (const m of SOURCE.matchAll(/req\.method === 'POST'[^\n]*joined === '([^']+)'/g)) {
    routes.add(m[1]);
  }
  // if (req.method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'thing')
  for (const m of SOURCE.matchAll(/req\.method === 'POST'[^\n]*parts\[0\] === 'v1' && parts\[1\] === '([^']+)'/g)) {
    routes.add(`v1/${m[1]}`);
  }
  return routes;
}

test("every POST route is allowed through the GET-only guard", () => {
  const allowed = allowedPostRoutes();
  const declared = declaredPostRoutes();

  assert.ok(declared.size > 0, "no POST routes found — the scraper is broken, not the file");

  const stranded = [...declared].filter((r) => !allowed.has(r));
  assert.deepEqual(
    stranded,
    [],
    `These POST routes are defined below the GET-only guard and will return 405 in production: ${stranded.join(", ")}. ` +
      "Add them to POST_ROUTES in api/[...path].js.",
  );
});

test("the guard's allow-set has no entries for routes that no longer exist", () => {
  const allowed = allowedPostRoutes();
  const declared = declaredPostRoutes();

  const orphaned = [...allowed].filter((r) => !declared.has(r));
  assert.deepEqual(
    orphaned,
    [],
    `POST_ROUTES lists routes with no matching handler: ${orphaned.join(", ")}. Remove them, or the guard ` +
      "advertises a write path that falls through to a 404.",
  );
});

test("the three routes this test exists for are specifically covered", () => {
  const allowed = allowedPostRoutes();
  for (const route of ["v1/fiat-confirmations", "v1/fraud-reports", "v1/intent"]) {
    assert.ok(allowed.has(route), `${route} must be reachable by POST — it returned 405 in production once already`);
  }
});
