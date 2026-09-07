import assert from "node:assert/strict";
import { test } from "node:test";

import { assembleInvestigation, prepareInvestigation } from "../src/investigate.js";
import type { InvestigationInput } from "../src/types.js";
import type { FraudReport } from "../../fraud-reports/src/types.js";

const SUBJECT = "GSUBJECT00000000000000000000000000000000000000000000";

function input(): InvestigationInput {
  const report: FraudReport = {
    id: "42",
    subject: SUBJECT,
    evidenceTxHash: "a".repeat(64),
    category: "wrong_amount",
    note: "",
    submittedAt: "2026-09-01T00:00:00Z",
    status: "unreviewed",
    disputedAt: null,
    disputeNote: null,
  };
  return {
    report,
    transaction: null,
    subjectFlags: [
      { id: "age", severity: "info", summary: "s", detail: "d", evidenceTxHashes: [] },
      { id: "concentration", severity: "warning", summary: "s2", detail: "d2", evidenceTxHashes: ["c".repeat(64)] },
    ],
    investigatedAt: "2026-09-07T00:00:00Z",
  };
}

test("prepareInvestigation is pure: facts, filtered signals, and a prompt, no I/O", () => {
  const prepared = prepareInvestigation(input());
  assert.ok(prepared.citedFacts.length > 0);
  assert.equal(prepared.relevantSignals.length, 1);
  assert.equal(prepared.relevantSignals[0]?.id, "concentration");
  assert.ok(prepared.prompt.system.length > 0);
  assert.ok(prepared.prompt.user.length > 0);
});

test("assembleInvestigation with a narrative keeps the model name", () => {
  const prepared = prepareInvestigation(input());
  const result = assembleInvestigation("42", "2026-09-07T00:00:00Z", prepared, "Plain-language summary.", "gpt-4o-mini");
  assert.equal(result.reportId, "42");
  assert.equal(result.narrative, "Plain-language summary.");
  assert.equal(result.narrativeModel, "gpt-4o-mini");
  assert.deepEqual(result.citedFacts, prepared.citedFacts);
  assert.deepEqual(result.relevantSignals, prepared.relevantSignals);
});

test("assembleInvestigation with no narrative degrades to nulls, not empty strings", () => {
  const prepared = prepareInvestigation(input());
  const result = assembleInvestigation("42", "2026-09-07T00:00:00Z", prepared, null, null);
  assert.equal(result.narrative, null);
  assert.equal(result.narrativeModel, null);
});

test("a model name is dropped alongside a null narrative rather than trusted on its own", () => {
  const prepared = prepareInvestigation(input());
  const result = assembleInvestigation("42", "2026-09-07T00:00:00Z", prepared, null, "gpt-4o-mini");
  assert.equal(result.narrative, null);
  assert.equal(result.narrativeModel, null);
});
