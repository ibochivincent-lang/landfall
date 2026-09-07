/**
 * x402 assembly — the piece README/ROADMAP have named and left unbuilt since
 * Stellar joined the x402 Foundation in July 2026.
 *
 * x402's own spec (https://github.com/x402-foundation/x402) settles *how
 * much* an agent may spend: a protected resource returns 402 with an
 * `accepts` array of `PaymentRequirements`, the client picks one, signs a
 * transfer authorization, and retries. It deliberately leaves open *who an
 * agent should be willing to pay* — the exact gap Landfall exists for, and
 * the one this repo has stated in README's "The agent gap" section since
 * before any code backed it.
 *
 * This module closes that gap for the one case Landfall can actually
 * answer: a `payTo` that is a classic Stellar account (G...) on a network
 * x402 identifies as Stellar (`stellar:pubnet` / `stellar:testnet`, per
 * CAIP-2 — see x402's `packages/mechanisms/stellar/src/constants.ts`). For
 * that case, `evaluatePaymentRequirements` runs the exact same Trust Check
 * used on the Trust Check page against the payee before any signature is
 * requested. For everything else — a different chain, a Soroban contract
 * address, a muxed account — it says plainly that it cannot help, rather
 * than silently omitting the entry or guessing.
 *
 * What this deliberately is not: a facilitator. Verifying and settling a
 * signed payment (x402's `/verify` and `/settle`) is infrastructure Stellar
 * already gets from the SDF/OpenZeppelin facilitator — duplicating it here
 * would mean holding or routing funds, which this project has refused to do
 * anywhere else (see docs/architecture/VERIFIED_ROUTES.md's "Execute route"
 * decision). This only reads.
 */

/**
 * One entry of x402's own `PaymentRequired.accepts` array — the exact shape
 * from x402-foundation/x402's `packages/core/src/types/payments.ts`, kept
 * as loose `unknown` fields this module doesn't use so a caller can pass
 * the real object through unmodified rather than needing to strip it down.
 */
export interface PaymentRequirements {
  scheme: string;
  /** CAIP-2 network id, e.g. "stellar:pubnet", "stellar:testnet", or another chain's. */
  network: string;
  /** Asset contract/issuer identifier — a Soroban token contract (C...) for Stellar. */
  asset: string;
  /** Atomic-unit amount as a string, per x402's spec. */
  amount: string;
  /** The address payment settles to — what this module assesses. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface UnsupportedPayee {
  requirement: PaymentRequirements;
  supported: false;
  /** Always says exactly what Landfall couldn't check and why — never a silent drop. */
  reason: string;
}

export interface SupportedPayee<TrustCheckResult> {
  requirement: PaymentRequirements;
  supported: true;
  trustCheck: TrustCheckResult;
}

export type PayeeAssessment<TrustCheckResult> = SupportedPayee<TrustCheckResult> | UnsupportedPayee;
