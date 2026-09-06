import assert from "node:assert/strict";
import { test } from "node:test";

import { summariseForSubject, validateSubmission, type SubmissionDraft } from "../src/validate.js";
import type { FraudReport } from "../src/types.js";

const SUBJECT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const OTHER = "GAXVPANTWKK5GHSPURVQKSJNMGI2K4FZE4CGDWIYIP5FEPFDKUTPPWZD";
const TX = "c1bbc39dd2f5f0e68c6ca7385cb55f07b4f9f8e050642fb0f1a2cd7360312cd0";

function draft(o: Partial<SubmissionDraft> = {}): SubmissionDraft {
  return { subject: SUBJECT, evidenceTxHash: TX, category: "did_not_receive", note: "Sent USDC, no payout received.", ...o };
}

function report(o: Partial<FraudReport> = {}): FraudReport {
  return {
    id: "r1", subject: SUBJECT, evidenceTxHash: TX, category: "did_not_receive",
    note: "n", submittedAt: "2026-01-01T00:00:00Z", status: "unreviewed", ...o,
  };
}

test("a well-formed report validates", () => {
  assert.equal(validateSubmission(draft()).ok, true);
});

test("a report with no transaction hash is rejected outright, not stored at low weight", () => {
  const r = validateSubmission(draft({ evidenceTxHash: "" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-tx-hash");
  assert.match(r.message!, /cannot be checked by anyone/);
});

test("a malformed transaction hash is rejected", () => {
  assert.equal(validateSubmission(draft({ evidenceTxHash: "not-a-hash" })).reason, "invalid-tx-hash");
  assert.equal(validateSubmission(draft({ evidenceTxHash: TX.slice(0, 63) })).reason, "invalid-tx-hash");
});

test("a malformed subject address is rejected", () => {
  assert.equal(validateSubmission(draft({ subject: "not-an-address" })).reason, "invalid-subject");
});

test("an unknown category is rejected rather than coerced to 'other'", () => {
  assert.equal(validateSubmission(draft({ category: "scam" })).reason, "invalid-category");
});

test("an empty description is rejected — a category alone is not a report", () => {
  assert.equal(validateSubmission(draft({ note: "   " })).reason, "note-empty");
});

test("an over-long description is rejected", () => {
  assert.equal(validateSubmission(draft({ note: "x".repeat(1001) })).reason, "note-too-long");
});

test("an address cannot report itself", () => {
  assert.equal(validateSubmission(draft({ reporterAddress: SUBJECT })).reason, "self-report");
});

test("reporting a different address is fine", () => {
  assert.equal(validateSubmission(draft({ reporterAddress: OTHER })).ok, true);
});

test("no reports reads as absence of evidence, explicitly not as a clean record", () => {
  const s = summariseForSubject(SUBJECT, []);
  assert.equal(s.total, 0);
  assert.match(s.summary, /not a clean bill of health/);
});

test("withdrawn and rejected reports are excluded from what is served", () => {
  const s = summariseForSubject(SUBJECT, [
    report({ id: "a" }),
    report({ id: "b", status: "withdrawn" }),
    report({ id: "c", status: "rejected" }),
  ]);
  assert.equal(s.total, 1);
  assert.deepEqual(s.reports.map((r) => r.id), ["a"]);
});

test("a dispute from the reported party is counted and surfaced", () => {
  const s = summariseForSubject(SUBJECT, [
    report({ id: "a", status: "disputed", disputedAt: "2026-01-02T00:00:00Z", disputeNote: "Payout was made, ref 123." }),
    report({ id: "b" }),
  ]);
  assert.equal(s.disputed, 1);
  assert.match(s.summary, /response from the reported party/);
});

test("the summary separates the verified part from the unverified part", () => {
  const s = summariseForSubject(SUBJECT, [report()]);
  assert.match(s.summary, /transaction is verified; the claim about what it means is not/);
});

test("the disclaimer refuses to let report volume become a score", () => {
  const s = summariseForSubject(SUBJECT, [report({ id: "a" }), report({ id: "b" }), report({ id: "c" })]);
  assert.match(s.disclaimer, /never scored, ranked, or blended/);
  assert.match(s.disclaimer, /claims by third parties, not findings by Landfall/);
  // There is deliberately no numeric risk field to render instead of the prose.
  assert.ok(!('score' in s), "a summary must not expose a score derived from report volume");
  assert.ok(!('riskLevel' in s));
});

test("every report carries a route to respond", () => {
  const s = summariseForSubject(SUBJECT, [report()]);
  assert.match(s.disclaimer, /DISPUTES\.md/);
});
