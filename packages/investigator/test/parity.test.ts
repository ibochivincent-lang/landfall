/**
 * api/[...path].js has no build step, so it can't import this package at
 * runtime — buildCitedFacts, extractRelevantSignals, buildPrompt,
 * prepareInvestigation and assembleInvestigation there are hand-written
 * mirrors, the same situation Trust Check's and Fraud Reports' mirrors are
 * already in. This imports the actual deployed file and runs shared
 * fixtures through both, alongside the real package.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { assembleInvestigation, prepareInvestigation } from "../src/investigate.js";
import { buildCitedFacts } from "../src/facts.js";
import { extractRelevantSignals } from "../src/signals.js";
import { buildPrompt } from "../src/prompt.js";
import type { InvestigationInput, RelevantSignal } from "../src/types.js";
import type { FraudReport } from "../../fraud-reports/src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_FILE = resolve(__dirname, "..", "..", "..", "api", "[...path].js");

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

const SUBJECT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const OTHER = "GAXVPANTWKK5GHSPURVQKSJNMGI2K4FZE4CGDWIYIP5FEPFDKUTPPWZD";
const TX = "c1bbc39dd2f5f0e68c6ca7385cb55f07b4f9f8e050642fb0f1a2cd7360312cd";

function report(o: Partial<FraudReport> = {}): FraudReport {
  return {
    id: "1",
    subject: SUBJECT,
    evidenceTxHash: TX,
    category: "did_not_receive",
    note: "",
    submittedAt: "2026-01-01T00:00:00Z",
    status: "unreviewed",
    disputedAt: null,
    disputeNote: null,
    ...o,
  };
}

function flag(o: Partial<RelevantSignal> = {}): RelevantSignal {
  return { id: "id", severity: "info", summary: "s", detail: "d", evidenceTxHashes: [], ...o };
}

const INPUTS: InvestigationInput[] = [
  { report: report(), transaction: null, subjectFlags: [], investigatedAt: "2026-01-02T00:00:00Z" },
  {
    report: report({ note: "sent it twice" }),
    transaction: { hash: TX, from: OTHER, to: SUBJECT, amount: "500", asset: "USDC", createdAt: "2025-12-30T00:00:00Z" },
    subjectFlags: [flag({ severity: "info" }), flag({ severity: "warning", id: "concentration" })],
    investigatedAt: "2026-01-02T00:00:00Z",
  },
  {
    report: report({ category: "impersonation", disputedAt: "2026-01-03T00:00:00Z", disputeNote: "not me" }),
    transaction: null,
    subjectFlags: [flag({ severity: "high", id: "forwarding" })],
    investigatedAt: "2026-01-03T00:00:00Z",
  },
];

test("the deployed API's cited facts agree with the package on every fixture", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    buildCitedFacts?: (i: InvestigationInput) => string[];
  };
  assert.equal(typeof mod.buildCitedFacts, "function", "buildCitedFacts missing from api/[...path].js");
  for (const input of INPUTS) {
    assert.deepEqual(mod.buildCitedFacts!(input), buildCitedFacts(input));
  }
});

test("the deployed API's relevant-signal filter agrees with the package", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    extractRelevantSignals?: (f: RelevantSignal[]) => RelevantSignal[];
  };
  for (const input of INPUTS) {
    assert.deepEqual(mod.extractRelevantSignals!(input.subjectFlags), extractRelevantSignals(input.subjectFlags));
  }
});

test("the deployed API's prompt builder agrees with the package", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    buildPrompt?: (facts: string[], signals: RelevantSignal[]) => unknown;
  };
  for (const input of INPUTS) {
    const facts = buildCitedFacts(input);
    const signals = extractRelevantSignals(input.subjectFlags);
    assert.deepEqual(mod.buildPrompt!(facts, signals), buildPrompt(facts, signals));
  }
});

test("the deployed API's prepare/assemble agree with the package end to end", async () => {
  const mod = (await import(pathToFileUrl(API_FILE))) as {
    prepareInvestigation?: (i: InvestigationInput) => unknown;
    assembleInvestigation?: (id: string, at: string, prepared: unknown, narrative: string | null, model: string | null) => unknown;
  };
  for (const input of INPUTS) {
    const preparedPkg = prepareInvestigation(input);
    const preparedApi = mod.prepareInvestigation!(input);
    assert.deepEqual(preparedApi, preparedPkg);

    const assembledPkg = assembleInvestigation("1", input.investigatedAt, preparedPkg, "A narrative.", "gpt-4o-mini");
    const assembledApi = mod.assembleInvestigation!("1", input.investigatedAt, preparedApi, "A narrative.", "gpt-4o-mini");
    assert.deepEqual(assembledApi, assembledPkg);

    const noModelPkg = assembleInvestigation("1", input.investigatedAt, preparedPkg, null, null);
    const noModelApi = mod.assembleInvestigation!("1", input.investigatedAt, preparedApi, null, null);
    assert.deepEqual(noModelApi, noModelPkg);
  }
});
