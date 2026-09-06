/**
 * The intent model.
 *
 * Route Scout has always asked "I am sending $100 — who pays out most?" That
 * is a comparison, and the person reading it does the deciding. An intent is
 * the other direction: a statement of what must be true when the payment
 * lands, which the system is then responsible for satisfying.
 *
 * The distinction that matters is not phrasing. It is that an intent can be
 * *unsatisfiable*, and saying so is a real answer. A comparison table always
 * has a top row, even when every row is a bad idea.
 */

/** Which side of the payment the user pinned down. */
export type AmountBasis =
  /** "I am sending $100." The payout falls out of the rate and fees. */
  | "send"
  /** "They must receive ₦500,000." The send amount falls out instead. */
  | "receive";

export interface Intent {
  /** Asset leaving the user, e.g. "USDC". */
  from: string;
  /** Destination fiat currency, e.g. "NGN". */
  to: string;
  /**
   * Which side `amount` refers to. This is the whole point of the model:
   * "pay ₦500k" and "send $310" are different instructions, and only one of
   * them can fail to have a solution.
   */
  basis: AmountBasis;
  /** Fixed side of the payment, in `from` units when basis is "send", in `to` units when "receive". */
  amount: number;

  /**
   * Reject routes whose settlement evidence is weaker than this.
   *
   * Optional and unset by default. A floor that silently defaults to
   * something would quietly discard routes the user never asked to exclude.
   */
  minGrade?: Grade;

  /**
   * Reject routes that publish no rate card.
   *
   * Unpriced anchors are quoted at nothing rather than estimated — see
   * `Solution.priced` — so this only controls whether they appear at all.
   */
  requirePricedTerms?: boolean;
}

export type Grade = "A" | "B" | "C" | "D" | "F" | "U";

/** Grades ordered worst to best, with U (untracked) below F: an unmeasured anchor is not a failing one, but it is not evidence either. */
export const GRADE_ORDER: readonly Grade[] = ["U", "F", "D", "C", "B", "A"];

export function gradeAtLeast(actual: Grade, floor: Grade): boolean {
  return GRADE_ORDER.indexOf(actual) >= GRADE_ORDER.indexOf(floor);
}

/** One anchor's terms for one corridor, as published by the anchor or held in the catalog. */
export interface RouteCandidate {
  domain: string;
  name: string;
  /** Multiplier on mid-market. 1 means quoted at mid; 0.99 means a 1% spread against the user. */
  rateSpread: number;
  /** Percentage fee, e.g. 0.8 for 0.8%. */
  feePercent: number;
  /** Flat fee in `from` units. */
  feeFixed: number;
  /** Where the fee figures came from. null means the anchor publishes none and the route cannot be priced. */
  feeSource: "live" | "catalog" | null;
  grade: Grade;
  /** 0–100 settlement reliability, or null when the anchor is untracked. */
  score: number | null;
}

/**
 * Why a route cannot satisfy an intent.
 *
 * These are kept as distinct reasons rather than collapsed into one "no"
 * because they are not the same fact and a caller may treat them differently:
 * `unpriced` is missing information, `fee-exceeds-principal` is arithmetic,
 * and `below-grade-floor` is the user's own filter doing its job.
 */
export type Rejection =
  | "unpriced"
  | "below-grade-floor"
  | "fee-exceeds-principal";

export interface Solution {
  domain: string;
  name: string;
  grade: Grade;
  score: number | null;

  /** False when the anchor publishes no terms; every money field below is then null. */
  priced: boolean;
  feeSource: "live" | "catalog" | null;

  /** Amount leaving the user, in `from` units. Derived when basis is "receive". */
  send: number | null;
  /** Amount landing at the destination, in `to` units. Derived when basis is "send". */
  receive: number | null;
  /** Effective rate applied, after the anchor's spread. */
  rate: number | null;
  /** Total fee in `from` units. */
  fee: number | null;

  /** Present only when the route cannot satisfy the intent. */
  rejected?: Rejection;
}

export interface SolveResult {
  intent: Intent;
  /** Mid-market rate the solve was performed against, `to` per one `from`. */
  midRate: number;
  /** Satisfying routes, best first. Best means most received (basis "send") or least sent (basis "receive"). */
  solutions: Solution[];
  /** Routes that cannot satisfy the intent, each with its reason. Never silently dropped. */
  rejected: Solution[];
  /**
   * True when no route can satisfy the intent at all.
   *
   * A comparison table cannot express this; an intent can, and it is often
   * the honest answer — every anchor on a corridor may charge more in fixed
   * fees than the user is trying to send.
   */
  unsatisfiable: boolean;
}
