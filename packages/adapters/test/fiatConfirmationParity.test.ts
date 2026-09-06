/**
 * api/[...path].js has no build step (vercel.json runs `npm install` only,
 * no tsc), so it cannot import packages/adapters/src/fiatConfirmation.ts at
 * runtime — evaluateFiatConfirmation() there is a hand-written JS mirror of
 * evaluateConfirmation() here. Two copies of the same eligibility rules is a
 * real drift hazard, the same one packages/web/intent.js has against
 * packages/intents/src/solve.ts, and it gets the same treatment: this test
 * imports the actual deployed file, runs a shared fixture set through both
 * implementations, and fails on any disagreement.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateConfirmation, type ConfirmationClaim, type NormalizedTransfer } from "../src/fiatConfirmation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_FILE = resolve(__dirname, "..", "..", "..", "api", "[...path].js");

const TRANSFER: NormalizedTransfer = { reference: "tx-abc123", observedAt: "2026-09-01T12:00:00.000Z" };

function claim(overrides: Partial<ConfirmationClaim> = {}): ConfirmationClaim {
  return {
    chain: "solana",
    reference: "tx-abc123",
    respondent: "recipient",
    outcome: "received",
    submittedAt: "2026-09-01T13:00:00.000Z",
    ...overrides,
  };
}

const FIXTURES: Array<[ConfirmationClaim, NormalizedTransfer, { maxAgeDays?: number }?]> = [
  [claim(), TRANSFER],
  [claim({ reference: "some-other-tx" }), TRANSFER],
  [claim({ respondent: "sender" }), TRANSFER],
  [claim({ outcome: "not_received" }), TRANSFER],
  [claim({ outcome: "partial" }), TRANSFER],
  [claim({ submittedAt: "2026-09-01T11:59:59.000Z" }), TRANSFER],
  [claim({ submittedAt: TRANSFER.observedAt }), TRANSFER],
  [claim({ submittedAt: "2026-10-15T12:00:00.000Z" }), TRANSFER, { maxAgeDays: 30 }],
  [claim({ submittedAt: "2026-09-05T12:00:00.000Z" }), TRANSFER, { maxAgeDays: 3 }],
  [claim({ submittedAt: "2026-10-01T11:59:00.000Z" }), TRANSFER],
  [claim({ submittedAt: "2026-10-01T12:01:00.000Z" }), TRANSFER],
];

test("the deployed API's evaluateFiatConfirmation agrees with the package on every fixture", async () => {
  const mod = await import(pathToFileUrl(API_FILE));
  assert.ok(typeof mod.evaluateFiatConfirmation === "function", `${API_FILE} did not export evaluateFiatConfirmation`);

  for (const [c, t, opts] of FIXTURES) {
    const mine = evaluateConfirmation(c, t, opts);
    const theirs = mod.evaluateFiatConfirmation(c, t, opts ?? {});
    const label = `${c.respondent}/${c.outcome} submitted=${c.submittedAt}` + (opts?.maxAgeDays ? ` maxAge=${opts.maxAgeDays}` : "");

    assert.equal(theirs.ok, mine.ok, `${label}: ok`);
    assert.equal(theirs.reason, mine.reason, `${label}: reason`);
    assert.deepEqual(theirs.proof, mine.proof, `${label}: proof`);
  }
});

function pathToFileUrl(path: string): string {
  // import() needs a file:// URL on Windows, not a bare drive-letter path.
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}
