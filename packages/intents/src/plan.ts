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

import type { Grade, Solution } from "./types.js";

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

/** Grades at or below this get a caution line attached to the plan. */
const CAUTION_AT_OR_BELOW: readonly Grade[] = ["D", "F", "U"];

export function buildPlan(input: PlanInput): Plan {
  const { solution, from, to } = input;
  const steps: PlanStep[] = [];
  let order = 1;

  const push = (step: Omit<PlanStep, "order">): void => {
    steps.push({ ...step, order: order++ });
  };

  push({
    id: "verify-counterparty",
    actor: "landfall",
    title: `Check ${solution.domain} before committing`,
    detail:
      "Read what the ledger shows about the anchor's own declared accounts — observed history, " +
      "counterparty concentration, and any pass-through pattern — before sending anything to them.",
    endpoint: `/api/v1/trust-check?address=${solution.domain}`,
  });

  push({
    id: "open-anchor-flow",
    actor: "user",
    title: `Start a withdrawal with ${solution.name}`,
    detail: input.anchorUrl
      ? `Open ${input.anchorUrl} and begin a SEP-24 withdrawal. The anchor runs its own KYC and quoting; ` +
        "Landfall is not in this exchange and never sees those details."
      : "Open the anchor's own withdrawal flow. The anchor runs its own KYC and quoting; Landfall is not in " +
        "this exchange and never sees those details.",
  });

  push({
    id: "establish-trustline",
    actor: "wallet",
    conditional: true,
    title: `Establish a trustline for ${from} if you do not already hold one`,
    detail:
      `Sending ${from} requires a trustline to that asset's issuer. Most wallets do this automatically ` +
      "when needed; it is listed because it is a real on-chain operation with its own fee and reserve.",
  });

  push({
    id: "send-payment",
    actor: "wallet",
    title:
      solution.send !== null
        ? `Send ${solution.send} ${from} to the address and memo the anchor gives you`
        : `Send ${from} to the address and memo the anchor gives you`,
    detail:
      "The destination address and memo come from the anchor's own SEP-24 response, never from Landfall — " +
      "a memo taken from the wrong place is how deposits get lost. Sign and submit from your own wallet; " +
      "Landfall holds no keys and cannot submit this for you.",
  });

  push({
    id: "await-settlement",
    actor: "anchor",
    title: input.speed ? `Wait for payout (${input.speed})` : "Wait for the anchor to pay out",
    detail:
      solution.receive !== null
        ? `The anchor converts and pays out roughly ${solution.receive} ${to}. The exact figure is the ` +
          "anchor's to quote at execution — the number here is computed from its published terms, not a guarantee."
        : "The anchor converts and pays out in local currency, at a rate it quotes at execution.",
  });

  push({
    id: "confirm-receipt",
    actor: "user",
    title: "Confirm whether the money actually arrived",
    detail:
      "This is the only step that produces evidence the fiat leg completed. Nothing on-chain shows a bank " +
      "deposit, so without a recipient saying so, the payout is invisible to Landfall and to everyone else " +
      "reading the ledger.",
    endpoint: "/api/v1/fiat-confirmations",
  });

  const weakEvidence = CAUTION_AT_OR_BELOW.includes(solution.grade);

  return {
    anchor: solution.name,
    anchorDomain: solution.domain,
    from,
    to,
    send: solution.send,
    receive: solution.receive,
    steps,
    executionNote:
      "This is a plan, not an execution. Landfall holds no keys, no funds and no custody, and every step " +
      "that moves value is performed by your own wallet or by the anchor. No step here can be triggered by " +
      "calling a Landfall endpoint.",
    caution: weakEvidence
      ? `This route's settlement evidence is graded ${solution.grade}` +
        (solution.score !== null ? ` (${solution.score}/100)` : " (untracked)") +
        ". That is a statement about how much settlement history the ledger shows for this anchor, not an " +
        "allegation about the operator — but it is thin evidence on which to send a large amount."
      : null,
  };
}
