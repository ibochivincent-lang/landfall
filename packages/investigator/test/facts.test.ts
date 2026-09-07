import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCitedFacts } from "../src/facts.js";
import type { InvestigationInput } from "../src/types.js";
import type { FraudReport } from "../../fraud-reports/src/types.js";

const SUBJECT = "GSUBJECT00000000000000000000000000000000000000000000";

function report(overrides: Partial<FraudReport> = {}): FraudReport {
  return {
    id: "1",
    subject: SUBJECT,
    evidenceTxHash: "a".repeat(64),
    category: "did_not_receive",
    note: "",
    submittedAt: "2026-09-01T00:00:00Z",
    status: "unreviewed",
    disputedAt: null,
    disputeNote: null,
    ...overrides,
  };
}

function input(overrides: Partial<InvestigationInput> = {}): InvestigationInput {
  return {
    report: report(),
    transaction: null,
    subjectFlags: [],
    investigatedAt: "2026-09-07T00:00:00Z",
    ...overrides,
  };
}

test("always cites the report itself and the verified-evidence fact", () => {
  const facts = buildCitedFacts(input());
  assert.ok(facts.some((f) => f.includes(SUBJECT) && f.includes("did not receive")));
  assert.ok(facts.some((f) => f.includes("a".repeat(64)) && f.includes("verified")));
});

test("includes transaction details only when a transaction was fetched", () => {
  const withoutTx = buildCitedFacts(input());
  assert.ok(withoutTx.some((f) => f.includes("could not be re-fetched")));

  const withTx = buildCitedFacts(
    input({
      transaction: {
        hash: "a".repeat(64),
        from: "GFROM0000000000000000000000000000000000000000000000000",
        to: SUBJECT,
        amount: "500",
        asset: "USDC",
        createdAt: "2026-08-30T00:00:00Z",
      },
    }),
  );
  assert.ok(withTx.some((f) => f.includes("500 USDC")));
});

test("includes the reporter's note only when non-empty, verbatim and unverified", () => {
  const noNote = buildCitedFacts(input());
  assert.ok(!noNote.some((f) => f.includes("reporter's own note")));

  const withNote = buildCitedFacts(input({ report: report({ note: "sent twice, got nothing" }) }));
  assert.ok(withNote.some((f) => f.includes("sent twice, got nothing") && f.includes("unverified")));
});

test("cites dispute state, including the dispute note when present", () => {
  const undisputed = buildCitedFacts(input());
  assert.ok(undisputed.some((f) => f.includes("has not disputed")));

  const disputed = buildCitedFacts(
    input({ report: report({ disputedAt: "2026-09-05T00:00:00Z", disputeNote: "this was a refund" }) }),
  );
  assert.ok(disputed.some((f) => f.includes("disputed this report") && f.includes("this was a refund")));
});
