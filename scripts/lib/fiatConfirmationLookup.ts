/**
 * Postgres-backed ConfirmationLookup for the recipient-confirmation binder
 * (packages/adapters/src/fiatConfirmation.ts).
 *
 * Kept out of packages/adapters on purpose: that package is pure interfaces
 * and logic with no I/O, matching the existing separation where every
 * DATABASE_URL-aware thing lives under scripts/ instead (verify-scan.ts,
 * dispatch-webhooks.mjs, publish-oracle.mjs all draw the same line).
 *
 * Backed by fiat_confirmations (packages/db/migrations/008_fiat_confirmations.sql),
 * written to by POST /api/v1/fiat-confirmations in api/[...path].js. This
 * module only ever reads it.
 */

import type { Pool } from "pg";
import type { ConfirmationClaim, ConfirmationLookup } from "../../packages/adapters/src/fiatConfirmation.js";

export function createDbConfirmationLookup(pool: Pool): ConfirmationLookup {
  return {
    async find(chain: string, reference: string): Promise<ConfirmationClaim | null> {
      const { rows } = await pool.query(
        `SELECT chain, reference, respondent, outcome, reported_amount, reported_currency, note, submitted_at
         FROM fiat_confirmations
         WHERE chain = $1 AND reference = $2`,
        [chain, reference],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        chain: row.chain,
        reference: row.reference,
        respondent: row.respondent,
        outcome: row.outcome,
        reportedAmount: row.reported_amount ?? undefined,
        reportedCurrency: row.reported_currency ?? undefined,
        note: row.note ?? undefined,
        // pg returns TIMESTAMPTZ as a JS Date; evaluateConfirmation compares
        // this against the transfer's own ISO timestamp via Date.parse.
        submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at),
      };
    },
  };
}
