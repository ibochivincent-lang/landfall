/**
 * api/[...path].js has no build step, so it can't import this package at
 * runtime — validateFraudSubmission and summariseFraudReports there are
 * hand-written mirrors, the same situation intent.js, the fiat-confirmation
 * evaluator and analyzeTrustCheck are already in. This imports the actual
 * deployed file and runs shared fixtures through both.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { summariseForSubject, validateSubmission, type SubmissionDraft } from "../src/validate.js";
import type { FraudReport } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_FILE = resolve(__dirname, "..", "..", "..", "api", "[...path].js");

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

const SUBJECT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const OTHER = "GAXVPANTWKK5GHSPURVQKSJNMGI2K4FZE4CGDWIYIP5FEPFDKUTPPWZD";
const TX = "c1bbc39dd2f5f0e68c6ca7385cb55f07b4f9f8e050642fb0f1a2cd7360312cd0";

const DRAFTS: SubmissionDraft[] = [
  { subject: SUBJECT, evidenceTxHash: TX, category: "did_not_receive", note: "No payout." },
  { subject: "nope", evidenceTxHash: TX, category: "did_not_receive", note: "No payout." },
  { subject: SUBJECT, evidenceTxHash: "", category: "did_not_receive", note: "No payout." },
  { subject: SUBJECT, evidenceTxHash: "short", category: "did_not_receive", note: "No payout." },
  { subject: SUBJECT, evidenceTxHash: TX, category: "scam", note: "No payout." },
  { subject: SUBJECT, evidenceTxHash: TX, category: "other", note: "" },
  { subject: SUBJECT, evidenceTxHash: TX, category: "other", note: "x".repeat(1001) },
  { subject: SUBJECT, evidenceTxHash: TX, category: "other", note: "ok", reporterAddress: SUBJECT },
  { subject: SUBJECT, evidenceTxHash: TX, category: "impersonation", note: "ok", reporterAddress: OTHER },
];

function report(o: Partial<FraudReport> = {}): FraudReport {
  return {
    id: "r", subject: SUBJECT, evidenceTxHash: TX, category: "did_not_receive",
    note: "n", submittedAt: "2026-01-01T00:00:00Z", status: "unreviewed", ...o,
  };
}

const REPORT_SETS: FraudReport[][] = [
  [],
  [report({ id: "a" })],
  [report({ id: "a" }), report({ id: "b" })],
  [report({ id: "a", status: "withdrawn" }), report({ id: "b", status: "rejected" })],
  [report({ id: "a", status: "disputed", disputedAt: "2026-01-02T00:00:00Z", disputeNote: "Paid, ref 1." }), report({ id: "b" })],
];

test("the deployed API's fraud validation agrees with the package on every draft", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    validateFraudSubmission?: (d: SubmissionDraft) => unknown;
  };
  assert.ok(typeof mod.validateFraudSubmission === "function", "validateFraudSubmission not exported");

  for (const [i, draft] of DRAFTS.entries()) {
    const mine = validateSubmission(draft);
    const theirs = JSON.parse(JSON.stringify(mod.validateFraudSubmission!(draft)));
    assert.deepEqual(theirs, mine, `draft ${i}`);
  }
});

test("the deployed API's report summary agrees with the package on every set", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    summariseFraudReports?: (s: string, r: FraudReport[]) => unknown;
  };
  assert.ok(typeof mod.summariseFraudReports === "function", "summariseFraudReports not exported");

  for (const [i, set] of REPORT_SETS.entries()) {
    const mine = summariseForSubject(SUBJECT, set);
    const theirs = JSON.parse(JSON.stringify(mod.summariseFraudReports!(SUBJECT, set)));
    assert.deepEqual(theirs, mine, `report set ${i}`);
  }
});
