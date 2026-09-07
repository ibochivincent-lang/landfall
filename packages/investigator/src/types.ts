/**
 * AI Investigator — the "Analyzed" stage of the fraud-report pipeline
 * (Reported -> Observed -> Analyzed -> Reviewed -> Attested; see
 * docs/product-vision-status.md, "Landfall Sentinel").
 *
 * A fraud report is already an accusation (packages/fraud-reports/src/types.ts
 * says so directly). This module reads one report plus the same ledger
 * signals Trust Check already computes for the subject, and produces two
 * strictly separate things:
 *
 *   1. `citedFacts` — a plain-language restatement of data Landfall has
 *      already verified (the report's own fields, the cited transaction,
 *      the subject's existing Trust Check flags). Computed with no AI
 *      involved at all, so it exists and is correct even when no model is
 *      configured.
 *
 *   2. `narrative` — an optional, explicitly-labeled AI summary of exactly
 *      those cited facts. It may explain what the facts could mean; it may
 *      never introduce a fact that isn't in `citedFacts`/`relevantSignals`,
 *      and it may never assert that the subject committed fraud — only a
 *      human review (packages/fraud-reports' `status: "reviewed"`) can move
 *      a report past "someone said". `narrative` is `null` whenever no
 *      model is configured, the same degrade-gracefully pattern
 *      packages/stp uses for unsigned digests.
 *
 * Deliberately excluded from the AI's input: how many *other* reports exist
 * about the same subject. Report volume is not evidence (fraud-reports'
 * design says "counts are never a verdict"); handing a count to a model
 * risks it being read as corroboration even without an explicit score.
 */

import type { Flag } from "../../trust-check/src/types.js";
import type { FraudReport } from "../../fraud-reports/src/types.js";

/** The cited transaction, fetched fresh so facts can quote its real amount/asset/parties — not just the existence check fraud-reports already did at submission time. */
export interface CitedTransaction {
  hash: string;
  from: string;
  to: string;
  amount: string;
  asset: string;
  createdAt: string;
}

/** A Trust Check flag reused verbatim — same shape, same evidence-hash discipline, no reinterpretation. */
export type RelevantSignal = Flag;

export interface InvestigationInput {
  report: FraudReport;
  /** Null if the cited transaction could no longer be fetched (e.g. a since-pruned Horizon window) — facts fall back to the report's own fields only. */
  transaction: CitedTransaction | null;
  /** The subject's own Trust Check flags, computed independently of this report. */
  subjectFlags: RelevantSignal[];
  investigatedAt: string;
}

export interface Prompt {
  system: string;
  user: string;
}

export interface Investigation {
  reportId: string;
  investigatedAt: string;
  /** Deterministic, always present, computed with no AI. */
  citedFacts: string[];
  relevantSignals: RelevantSignal[];
  /** Explicitly AI-generated prose synthesizing only citedFacts + relevantSignals, or null if no model is configured. */
  narrative: string | null;
  /** Model identifier the narrative came from, or null alongside a null narrative. */
  narrativeModel: string | null;
}
