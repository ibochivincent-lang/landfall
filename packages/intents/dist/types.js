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
/** Grades ordered worst to best, with U (untracked) below F: an unmeasured anchor is not a failing one, but it is not evidence either. */
export const GRADE_ORDER = ["U", "F", "D", "C", "B", "A"];
export function gradeAtLeast(actual, floor) {
    return GRADE_ORDER.indexOf(actual) >= GRADE_ORDER.indexOf(floor);
}
export const LIQUIDITY_ORDER = ["unknown", "low", "medium", "high"];
//# sourceMappingURL=types.js.map