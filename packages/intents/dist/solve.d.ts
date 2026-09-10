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
import { type Intent, type RouteCandidate, type SolveResult } from "./types.js";
/**
 * Solve one intent against a set of candidate routes.
 *
 * Pure: no fetching, no clock, no globals. Everything it needs is an
 * argument, so the same call always gives the same answer and the tests can
 * pin the arithmetic exactly.
 */
export declare function solveIntent(intent: Intent, candidates: readonly RouteCandidate[], midRate: number): SolveResult;
//# sourceMappingURL=solve.d.ts.map