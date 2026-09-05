/**
 * Finality levels (SPEC.md §9).
 *
 * "Confirmed" is not a useful answer to "how strong is this commitment", and
 * the reason is specific to Stellar. SCP is neither proof-of-work nor
 * conventional proof-of-stake: safety rests on quorum configuration and
 * quorum intersection, so there is no accumulated work making an old ledger
 * progressively more expensive to rewrite. Over a ten-year horizon "the ledger
 * says so" and "several mutually independent parties still hold a copy saying
 * so" are meaningfully different claims, and a proof format that cannot tell
 * them apart is hiding the interesting part.
 *
 * These levels are strictly ordered and never blended into a score, for the
 * same reason the settlement evidence tiers elsewhere in this repository are
 * not: a single number lets a weaker claim be presented as a stronger one.
 */

export type FinalityLevel = 1 | 2 | 3;

export const FINALITY = {
  LEDGER: 1,
  ARCHIVED: 2,
  CHECKPOINTED: 3,
} as const;

export interface FinalityAssessment {
  level: FinalityLevel;
  name: "LEDGER" | "ARCHIVED" | "CHECKPOINTED";
  /** What this level actually asserts, in one sentence a reader can check. */
  claim: string;
  /** What it deliberately does not assert. */
  limit: string;
  /** How many independent history archives confirmed the ledger. */
  archivesConfirming: number;
  /** External-chain checkpoints covering this root, if any. */
  externalCheckpoints: number;
}

export interface FinalityInput {
  /** Confirmed present in an externalised ledger. */
  inLedger: boolean;
  /** Count of independent history archives that returned the same ledger. */
  archivesConfirming?: number;
  /** Count of external-chain checkpoints proven to cover this root. */
  externalCheckpoints?: number;
}

/**
 * Assess a commitment's finality from what has actually been checked.
 *
 * Deliberately takes evidence counts rather than booleans for levels 2 and 3:
 * "archived" is not a yes/no property, it is a question of how many
 * independent parties would have to cooperate to make the record disappear,
 * and the answer belongs in the output.
 */
export function assessFinality(input: FinalityInput): FinalityAssessment {
  const archives = input.archivesConfirming ?? 0;
  const checkpoints = input.externalCheckpoints ?? 0;

  if (!input.inLedger) {
    throw new Error(
      "Finality cannot be assessed for a commitment not confirmed in a ledger — there is nothing to grade.",
    );
  }

  if (checkpoints > 0) {
    return {
      level: FINALITY.CHECKPOINTED,
      name: "CHECKPOINTED",
      claim:
        `This root is committed in an externalised Stellar ledger and additionally covered by ` +
        `${checkpoints} external-chain checkpoint(s), so rewriting it requires attacking that chain as well.`,
      limit:
        "Only as strong as the weakest chain in the set, and only from the checkpoint's own timestamp onward.",
      archivesConfirming: archives,
      externalCheckpoints: checkpoints,
    };
  }

  if (archives > 0) {
    return {
      level: FINALITY.ARCHIVED,
      name: "ARCHIVED",
      claim:
        `This root is committed in an externalised Stellar ledger and independently retrievable from ` +
        `${archives} history archive(s), so it survives the loss or revision of any one of them.`,
      limit:
        "Independence is assumed from the archives being separately operated; it is not cryptographically proven.",
      archivesConfirming: archives,
      externalCheckpoints: 0,
    };
  }

  return {
    level: FINALITY.LEDGER,
    name: "LEDGER",
    claim: "This root is committed in an externalised Stellar ledger under SCP.",
    limit:
      "Rests entirely on Stellar's live quorum. No independent archive copy and no external checkpoint has been confirmed for it.",
    archivesConfirming: 0,
    externalCheckpoints: 0,
  };
}
