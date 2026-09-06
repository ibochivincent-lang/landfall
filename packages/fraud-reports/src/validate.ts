import {
  NOTE_MAX_LENGTH,
  VALID_CATEGORIES,
  type FraudReport,
  type ReportsForSubject,
  type ValidationResult,
} from "./types.js";

const G_ADDRESS = /^G[A-Z2-7]{55}$/;
const TX_HASH = /^[0-9a-f]{64}$/i;

export interface SubmissionDraft {
  subject: string;
  evidenceTxHash: string;
  category: string;
  note: string;
  /** The reporter's own address, when they supplied one. Used only to reject self-reports. */
  reporterAddress?: string | null;
}

/**
 * Shape and sanity checks only. Whether the cited transaction actually
 * exists and actually involves `subject` is a ledger question, answered by
 * the caller against Horizon — this function has no I/O and deliberately
 * cannot fake that check.
 */
export function validateSubmission(draft: SubmissionDraft): ValidationResult {
  const subject = String(draft.subject ?? "").trim();
  const txHash = String(draft.evidenceTxHash ?? "").trim();
  const note = String(draft.note ?? "").trim();
  const category = String(draft.category ?? "").trim();

  if (!G_ADDRESS.test(subject)) {
    return { ok: false, reason: "invalid-subject", message: "The reported address must be a Stellar public key (G...)." };
  }
  if (!TX_HASH.test(txHash)) {
    return {
      ok: false,
      reason: "invalid-tx-hash",
      message:
        "A report must cite a transaction hash (64 hex characters). A report with no on-chain evidence " +
        "cannot be checked by anyone, including you, so it is not accepted.",
    };
  }
  if (!VALID_CATEGORIES.includes(category as never)) {
    return { ok: false, reason: "invalid-category", message: `Category must be one of: ${VALID_CATEGORIES.join(", ")}.` };
  }
  if (note.length === 0) {
    return { ok: false, reason: "note-empty", message: "Describe what happened — a category alone is not a report." };
  }
  if (note.length > NOTE_MAX_LENGTH) {
    return { ok: false, reason: "note-too-long", message: `Keep the description under ${NOTE_MAX_LENGTH} characters.` };
  }

  // Reporting yourself is either a mistake or an attempt to manufacture a
  // record. Neither is worth storing against a real address.
  const reporter = String(draft.reporterAddress ?? "").trim();
  if (reporter && reporter === subject) {
    return { ok: false, reason: "self-report", message: "An address cannot file a report against itself." };
  }

  return { ok: true };
}

/**
 * Assembles what is known about an address, with the caveat attached to the
 * data rather than left to the caller to remember.
 *
 * Withdrawn and rejected reports are excluded outright: a withdrawn report
 * is one the reporter took back, and continuing to serve it would punish
 * someone for a retraction.
 */
export function summariseForSubject(subject: string, all: readonly FraudReport[]): ReportsForSubject {
  const visible = all.filter((r) => r.status !== "withdrawn" && r.status !== "rejected");
  const disputed = visible.filter((r) => r.status === "disputed").length;

  let summary: string;
  if (visible.length === 0) {
    summary =
      "No reports have been filed about this address. That is not a clean bill of health — it may equally " +
      "mean nobody affected has found this page.";
  } else {
    const plural = visible.length === 1 ? "report" : "reports";
    summary =
      `${visible.length} ${plural} filed by ${visible.length === 1 ? "someone" : "people"} claiming to have been ` +
      "affected, each citing a transaction that was checked to exist on-chain and involve this address. " +
      "The transaction is verified; the claim about what it means is not. " +
      (disputed > 0
        ? `${disputed} of them ${disputed === 1 ? "has" : "have"} a response from the reported party attached.`
        : "None has been disputed by the reported party.");
  }

  return {
    subject,
    reports: visible,
    total: visible.length,
    disputed,
    summary,
    disclaimer:
      "These are claims by third parties, not findings by Landfall. Landfall verifies only that the cited " +
      "transaction exists and involves this address — it has no way to establish what was agreed between " +
      "the parties, and does not try. Report volume is never scored, ranked, or blended into any Landfall " +
      "figure. If a report about you is wrong, see DISPUTES.md; a response will be attached to it here.",
  };
}
