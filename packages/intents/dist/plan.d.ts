/**
 * The Intent Engine's second half: turning a solved route into a plan.
 *
 * solve.ts answers "which route?". This answers "then what?" — the ordered
 * steps someone actually has to perform to make the intent happen, each one
 * naming who performs it.
 *
 * That last part is the whole design constraint. Landfall does not execute
 * anything: it holds no keys, no funds, and no custody. So every step here
 * carries an explicit `actor`, and the only value `"landfall"` ever appears
 * on is a step that reads public data. Steps that move money are always
 * `"wallet"` or `"anchor"`. A plan that quietly implied otherwise would be
 * the same category of overclaim as a fabricated exchange rate — see
 * docs/architecture/VERIFIED_ROUTES.md, which declined an "Execute route"
 * button for exactly this reason.
 *
 * The plan also deliberately ends *after* settlement rather than at the
 * point the payment is submitted, because the fiat leg is the part this
 * project cannot see (packages/adapters/src/fiatConfirmation.ts). The final
 * step is the recipient confirming receipt — the one piece of evidence that
 * closes the loop, and the one thing no amount of ledger reading can supply.
 */
import type { Solution } from "./types.js";
/** Who performs a step. Never "landfall" for anything that moves value. */
export type StepActor = "user" | "wallet" | "anchor" | "landfall";
export interface PlanStep {
    /** Stable identifier, so a client can match a step to its own UI without parsing prose. */
    id: string;
    order: number;
    actor: StepActor;
    title: string;
    detail: string;
    /**
     * A Landfall endpoint that helps with this step, when one exists. Present
     * so a wallet integrating this can wire the step to something real rather
     * than being told to "verify the counterparty" with no means to do it.
     */
    endpoint?: string;
    /** True when the step can be skipped depending on wallet state (e.g. a trustline that already exists). */
    conditional?: boolean;
}
export interface PlanInput {
    /** The chosen route. Must be a priced solution — an unpriced one has no amounts to plan around. */
    solution: Solution;
    from: string;
    to: string;
    /** The anchor's own off-ramp entry point, from the catalog. */
    anchorUrl?: string;
    /** Human description of expected payout speed, e.g. "Instant · 1–3 min". */
    speed?: string;
}
export interface Plan {
    anchor: string;
    anchorDomain: string;
    from: string;
    to: string;
    send: number | null;
    receive: number | null;
    steps: PlanStep[];
    /** Restated on the plan itself, not only in docs: this is a plan, not an execution. */
    executionNote: string;
    /** Present when the chosen route's evidence is weak enough that a caller should surface it alongside the plan. */
    caution: string | null;
}
export declare function buildPlan(input: PlanInput): Plan;
//# sourceMappingURL=plan.d.ts.map