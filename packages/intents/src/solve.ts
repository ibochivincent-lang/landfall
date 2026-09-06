/**
 * The solver.
 *
 * Forward (basis "send") is what Route Scout always did:
 *
 *     rate    = midRate × rateSpread
 *     fee     = send × feePercent/100 + feeFixed
 *     receive = (send − fee) × rate
 *
 * Reverse (basis "receive") solves the same relation for `send`:
 *
 *     send − (send × p + f) = receive / rate        where p = feePercent/100
 *     send × (1 − p)        = receive / rate + f
 *     send                  = (receive / rate + f) / (1 − p)
 *
 * The (1 − p) denominator is the part worth being careful about. At p ≥ 1 the
 * anchor's percentage fee consumes the whole principal and no send amount
 * reaches the target — the equation has no solution in the positive reals,
 * not a very large one. That is a real condition, not a hypothetical: the
 * fee refresh found an anchor publishing 20% where the catalog claimed 0.4%,
 * so the assumption that percentage fees are small is exactly the kind of
 * thing this codebase has already been wrong about once.
 */

import {
  GRADE_ORDER,
  LIQUIDITY_ORDER,
  gradeAtLeast,
  type Intent,
  type RouteCandidate,
  type SolveResult,
  type Solution,
} from "./types.js";

/** Round to a currency-sane number of places without dragging in a decimal library. */
function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function unpriced(c: RouteCandidate): Solution {
  return {
    domain: c.domain,
    name: c.name,
    grade: c.grade,
    score: c.score,
    liquidityTier: c.liquidityTier ?? "unknown",
    recentPayments: c.recentPayments ?? null,
    priced: false,
    feeSource: null,
    send: null,
    receive: null,
    rate: null,
    fee: null,
  };
}

/**
 * Solve one intent against a set of candidate routes.
 *
 * Pure: no fetching, no clock, no globals. Everything it needs is an
 * argument, so the same call always gives the same answer and the tests can
 * pin the arithmetic exactly.
 */
export function solveIntent(
  intent: Intent,
  candidates: readonly RouteCandidate[],
  midRate: number,
): SolveResult {
  const solutions: Solution[] = [];
  const rejected: Solution[] = [];

  for (const c of candidates) {
    // The user's own filter, applied before anything is computed.
    if (intent.minGrade && !gradeAtLeast(c.grade, intent.minGrade)) {
      rejected.push({ ...unpriced(c), rejected: "below-grade-floor" });
      continue;
    }

    // No published terms and nothing in the catalog. The route is listed but
    // not priced — inventing a spread here would put a fabricated number in
    // front of someone deciding where to send money.
    if (c.feeSource === null) {
      if (intent.requirePricedTerms) {
        rejected.push({ ...unpriced(c), rejected: "unpriced" });
      } else {
        solutions.push(unpriced(c));
      }
      continue;
    }

    const rate = round(midRate * c.rateSpread, 4);
    const p = c.feePercent / 100;

    if (intent.basis === "send") {
      const send = intent.amount;
      const fee = round(send * p + c.feeFixed, 2);
      // A fee larger than the principal is not a zero payout, it is a route
      // that cannot carry this payment. Clamping to zero and ranking it last
      // would present an impossibility as merely a bad deal.
      if (fee >= send) {
        rejected.push({ ...unpriced(c), feeSource: c.feeSource, rejected: "fee-exceeds-principal" });
        continue;
      }
      const receive = round((send - fee) * rate, 2);
      solutions.push({
        domain: c.domain, name: c.name, grade: c.grade, score: c.score,
        liquidityTier: c.liquidityTier ?? "unknown", recentPayments: c.recentPayments ?? null,
        priced: true, feeSource: c.feeSource,
        send, receive, rate, fee,
      });
    } else {
      // Reverse. p ≥ 1 means the percentage fee eats the entire principal at
      // any size, so the target is unreachable through this anchor.
      if (p >= 1) {
        rejected.push({ ...unpriced(c), feeSource: c.feeSource, rejected: "fee-exceeds-principal" });
        continue;
      }
      const receive = intent.amount;
      const principal = receive / rate;
      // Rounded UP to the cent, not to nearest. The send side is denominated
      // in cents and the destination side is multiplied by a rate in the
      // thousands, so half a cent of rounding is several naira at the far end.
      // Rounding to nearest therefore delivers slightly *under* the target
      // about half the time, and "pay ₦500,000" that pays ₦499,994 is a failed
      // instruction, not a rounding detail. Up costs the sender at most one
      // cent and keeps the intent's promise.
      const send = Math.ceil(((principal + c.feeFixed) / (1 - p)) * 100) / 100;
      const fee = round(send - principal, 2);
      solutions.push({
        domain: c.domain, name: c.name, grade: c.grade, score: c.score,
        liquidityTier: c.liquidityTier ?? "unknown", recentPayments: c.recentPayments ?? null,
        priced: true, feeSource: c.feeSource,
        send, receive, rate, fee,
      });
    }
  }

  /* Ranking flips with the basis, and this is the substantive difference
     between an intent and a comparison table. Sending a fixed amount, best
     means the most delivered. Delivering a fixed amount, best means the least
     spent. Ranking a receive-first result by payout would put every anchor in
     a tie, since they all deliver exactly the target. */
  /** Amount comparison in the direction "better" already means for this intent's basis. */
  const byAmount = (a: Solution, b: Solution): number =>
    intent.basis === "send" ? (b.receive ?? 0) - (a.receive ?? 0) : (a.send ?? 0) - (b.send ?? 0);

  const better = (a: Solution, b: Solution): number => {
    if (a.priced !== b.priced) return a.priced ? -1 : 1;
    if (!a.priced) return (b.score ?? 0) - (a.score ?? 0);

    if (intent.sortBy === "verified") {
      // Evidence before price. A route with a stronger grade and more
      // recently observed activity outranks a cheaper one with neither —
      // see docs/architecture/VERIFIED_ROUTES.md for why "cheapest that
      // clears a reliability floor" was rejected in favor of this: a floor
      // treats a B-grade anchor and a D-grade anchor identically as long as
      // both clear it, which throws away exactly the distinction a route
      // ranked by evidence exists to keep. Amount only breaks a tie between
      // two routes with identical grade and liquidity — it never overrides
      // either, on purpose: blending them into one score is the thing this
      // codebase already refuses to do (pickAnchor, cross-chain.html).
      const gradeDelta = GRADE_ORDER.indexOf(b.grade) - GRADE_ORDER.indexOf(a.grade);
      if (gradeDelta !== 0) return gradeDelta;
      const liquidityDelta = LIQUIDITY_ORDER.indexOf(b.liquidityTier) - LIQUIDITY_ORDER.indexOf(a.liquidityTier);
      if (liquidityDelta !== 0) return liquidityDelta;
      return byAmount(a, b);
    }

    return byAmount(a, b);
  };
  solutions.sort((a, b) => better(a, b) || a.domain.localeCompare(b.domain));
  rejected.sort((a, b) => a.domain.localeCompare(b.domain));

  return {
    intent,
    midRate,
    solutions,
    rejected,
    // Unpriced routes are listed, but they satisfy nothing — an intent with
    // only unpriced routes has no route that is known to work.
    unsatisfiable: solutions.filter((s) => s.priced).length === 0,
  };
}
