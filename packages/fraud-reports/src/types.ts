/**
 * Fraud Reports — the module this project has been deliberately refusing to
 * fake.
 *
 * packages/trust-check/src/analyze.ts ships with a line saying no external
 * fraud feed is used "because none exist here that this project can
 * independently verify," and that when Fraud Reports lands it becomes "a
 * second, separately labeled input, never silently blended into" the
 * ledger-derived signals. This is that module, built to honour that promise
 * literally.
 *
 * The hard part is not storage. It is that this feature lets an anonymous
 * stranger publish an allegation about a named party, and the project's own
 * DISPUTES.md and CODE_OF_CONDUCT.md already commit to not converting a
 * ledger fact into an accusation. A fraud report IS an accusation. So the
 * design constraints are stricter than anywhere else in this codebase:
 *
 *   1. A report is always attributed to "someone said", never to Landfall.
 *      There is no field anywhere in this module that lets Landfall endorse
 *      a report's truth, because there is no process here that could
 *      establish it.
 *
 *   2. Every report must cite a transaction hash that actually exists on
 *      the ledger and actually involves the address being reported. That is
 *      verifiable, it is verified (see verifyEvidence in the API layer), and
 *      it is the entire difference between this and a comment box. An
 *      unverifiable report is rejected, not stored quietly at low weight.
 *
 *   3. Counts are never a verdict. Three reports is three strangers, which
 *      may be three victims or one person with three browsers. `status`
 *      stays "unreviewed" until a human reviews it, and nothing in this
 *      module ever computes a score from report volume.
 *
 *   4. The reported party can always respond. `disputedAt`/`disputeNote`
 *      exist so a response travels with the report, in the same payload,
 *      rather than living somewhere a reader will never look.
 */

/** What the reporter says happened. Narrow, so the claim is legible; "other" exists so the list is not a trap. */
export type ReportCategory =
  | "did_not_receive"
  | "wrong_amount"
  | "impersonation"
  | "unauthorized_debit"
  | "other";

/**
 * A report's lifecycle. Note what is missing: there is no "confirmed" or
 * "proven" state, because nothing in this system can establish that. The
 * strongest state is "reviewed", meaning a human read it and the cited
 * evidence checked out — not that the allegation is true.
 */
export type ReportStatus = "unreviewed" | "reviewed" | "disputed" | "withdrawn" | "rejected";

export interface FraudReport {
  id: string;
  /** The Stellar address the report is about. */
  subject: string;
  /** Transaction hash the reporter cites. Must involve `subject` — checked, not trusted. */
  evidenceTxHash: string;
  category: ReportCategory;
  /** Free text from the reporter, length-capped. Stored verbatim, believed by nobody. */
  note: string;
  /** Server clock, never the client's. */
  submittedAt: string;
  status: ReportStatus;
  /** Set when the reported party responds. Travels with the report, always. */
  disputedAt?: string | null;
  disputeNote?: string | null;
}

export type RejectionReason =
  | "invalid-subject"
  | "invalid-tx-hash"
  | "invalid-category"
  | "note-too-long"
  | "note-empty"
  | "self-report";

export interface ValidationResult {
  ok: boolean;
  reason?: RejectionReason;
  message?: string;
}

/**
 * What a caller gets back when asking what has been reported about an
 * address. Shaped so that the caveat cannot be dropped by a client that
 * only reads the numbers: `summary` is prose, and there is no aggregate
 * score field to render instead of it.
 */
export interface ReportsForSubject {
  subject: string;
  /** Reports whose cited evidence verified, minus withdrawn and rejected ones. */
  reports: FraudReport[];
  total: number;
  disputed: number;
  /** Always present, always says what the count does and does not mean. */
  summary: string;
  /** Stated separately from the reports so a consumer cannot mistake this for a Landfall finding. */
  disclaimer: string;
}

export const NOTE_MAX_LENGTH = 1000;

export const VALID_CATEGORIES: readonly ReportCategory[] = [
  "did_not_receive",
  "wrong_amount",
  "impersonation",
  "unauthorized_debit",
  "other",
];
