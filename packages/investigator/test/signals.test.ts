import assert from "node:assert/strict";
import { test } from "node:test";

import { extractRelevantSignals } from "../src/signals.js";
import type { RelevantSignal } from "../src/types.js";

function flag(overrides: Partial<RelevantSignal>): RelevantSignal {
  return {
    id: "id",
    severity: "info",
    summary: "summary",
    detail: "detail",
    evidenceTxHashes: [],
    ...overrides,
  };
}

test("drops info flags, keeps warning and high", () => {
  const flags = [flag({ severity: "info" }), flag({ severity: "warning" }), flag({ severity: "high" })];
  const result = extractRelevantSignals(flags);
  assert.equal(result.length, 2);
  assert.ok(result.every((f) => f.severity !== "info"));
});

test("empty input yields empty output", () => {
  assert.deepEqual(extractRelevantSignals([]), []);
});
