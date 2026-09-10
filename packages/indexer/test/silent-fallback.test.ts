/**
 * Guards one structural property of cli.ts: the admin-added-domains lookup
 * must not fail silently.
 *
 * On 8 September 2026 zeam.money — admin-added, so present only in
 * `tracked_anchors` — vanished from a scan with all fifteen of its accounts.
 * Its TOML resolved and it was still tracked. It had simply never been asked,
 * because this lookup timed out and the catch swallowed it: no log line, no
 * resolve_error, nothing to separate it from an anchor that was never tracked.
 * A consumer could not tell the difference, which is the ambiguity this
 * project exists to remove from anchor self-reporting.
 *
 * Read from source rather than executed, for the same reason
 * api/_lib/routes.test.mjs does: importing cli.ts runs the CLI, and the
 * property worth guarding is structural — that the catch reports rather than
 * hides.
 *
 *   npm test -w @landfall/indexer
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(__dirname, "..", "src", "cli.ts"), "utf8");

/** The body of loadDomains' catch block. */
function catchBody(): string {
  const start = SOURCE.indexOf("async function loadDomains");
  assert.ok(start > -1, "loadDomains not found — was it renamed?");
  const region = SOURCE.slice(start, start + 3000);
  const c = region.indexOf("} catch");
  assert.ok(c > -1, "loadDomains has no catch — the fallback was removed?");
  return region.slice(c, region.indexOf("} finally"));
}

test("the admin-domains fallback reports the failure instead of swallowing it", () => {
  const body = catchBody();
  assert.ok(
    /process\.stderr\.write|console\.(error|warn)/.test(body),
    "loadDomains' catch must report. A silent fallback drops every admin-added " +
      "anchor from the scan, and its absence from the published record then looks " +
      "identical to an anchor that was never tracked.",
  );
});

test("the reported failure says the scan is partial, not merely that something failed", () => {
  const body = catchBody();
  assert.match(
    body,
    /FAIL/,
    "the message should carry the project's FAIL marker, as a domain that cannot " +
      "be reached is a finding rather than a gap",
  );
  assert.ok(
    /NOT in this scan|not in this scan/i.test(body),
    "the message must say the affected anchors are missing from THIS scan — the " +
      "operational fact a reader needs, rather than just naming the error",
  );
});

test("the lookup uses the same connection timeout as every other caller", () => {
  // It was 3s here while Store's own default and every other caller in the
  // repository use 8s against the same pooled database — which made this the
  // most likely lookup to time out, and the only one that hid it.
  const start = SOURCE.indexOf("async function loadDomains");
  const region = SOURCE.slice(start, start + 3000);
  const m = region.match(/connectionTimeoutMillis:\s*([0-9_]+)/);
  assert.ok(m && m[1], "loadDomains sets connection timeout");
  assert.equal(
    Number(m[1].replace(/_/g, "")),
    8000,
    "should match the 8s used by Store's default and every other caller",
  );
});
