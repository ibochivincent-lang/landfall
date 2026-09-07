/**
 * Deterministic, AI-free restatement of what is already verified about one
 * fraud report. See types.ts for why this stays strictly separate from the
 * optional narrative.
 */

import type { CitedTransaction, InvestigationInput } from "./types.js";

const CATEGORY_LABEL: Record<string, string> = {
  did_not_receive: "the reporter says they did not receive an expected payment",
  wrong_amount: "the reporter says the amount received did not match what was expected",
  impersonation: "the reporter says this address impersonated another party",
  unauthorized_debit: "the reporter says funds moved without authorization",
  other: "the reporter describes a claim outside the standard categories",
};

function formatTransaction(tx: CitedTransaction): string {
  return `The cited transaction ${tx.hash} moved ${tx.amount} ${tx.asset} from ${tx.from} to ${tx.to} on ${tx.createdAt}.`;
}

/**
 * Every string here is either a direct field of the report/transaction or a
 * fixed label keyed off `category` — nothing here is inferred or scored.
 */
export function buildCitedFacts(input: InvestigationInput): string[] {
  const { report, transaction } = input;
  const facts: string[] = [];

  facts.push(
    `A fraud report was filed against ${report.subject} on ${report.submittedAt}: ${CATEGORY_LABEL[report.category] ?? CATEGORY_LABEL.other}.`,
  );

  facts.push(
    `Landfall verified that transaction ${report.evidenceTxHash} exists on the Stellar ledger and involves ${report.subject} before this report was stored.`,
  );

  if (transaction) {
    facts.push(formatTransaction(transaction));
  } else {
    facts.push(
      `The cited transaction's full details could not be re-fetched at investigation time; only the evidence tx hash above is confirmed.`,
    );
  }

  if (report.note.trim().length > 0) {
    facts.push(`The reporter's own note, stored verbatim and unverified: "${report.note.trim()}"`);
  }

  if (report.disputedAt) {
    const disputeNote = report.disputeNote?.trim();
    facts.push(
      disputeNote
        ? `The reported address disputed this report on ${report.disputedAt}, with a signature proving control of the address: "${disputeNote}"`
        : `The reported address disputed this report on ${report.disputedAt}, with a signature proving control of the address.`,
    );
  } else {
    facts.push(`The reported address has not disputed this report.`);
  }

  return facts;
}
