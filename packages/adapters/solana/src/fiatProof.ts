import type { TokenBalanceDelta } from "./rpc.js";
import {
  createRecipientConfirmationBinder,
  type ConfirmationLookup,
  type EvaluateOptions,
} from "../../src/fiatConfirmation.js";


export type FiatLegProofKind = "zktls" | "proof_of_reserve" | "recipient_confirmation";

export interface FiatLegProof {
  kind: FiatLegProofKind;
  /** Reference to the off-chain proof artifact — never the raw fiat account/receipt data itself. */
  ref: string;
}

/**
 * Binds an SPL token balance change to the off-chain proof that makes it
 * DERIVED evidence rather than a bare, unattributed transfer
 * (MULTICHAIN.md §4). Mirrors the Tron adapter's binder — same shape, so a
 * real zkTLS/Proof-of-Reserve integration can implement one interface
 * shared in spirit across both DERIVED-tier adapters.
 */
export interface FiatLegProofBinder {
  bind(delta: TokenBalanceDelta): Promise<FiatLegProof | null>;
}

/** The honest default: binds nothing, so scan() emits zero events until a real proof integration is plugged in. */
export const NULL_FIAT_LEG_BINDER: FiatLegProofBinder = {
  async bind() {
    return null;
  },
};

/**
 * The recipient-confirmation binder (packages/adapters/src/fiatConfirmation.ts).
 * The weakest of the three ways to bind this proof — no counterparty
 * cooperation needed, no cryptography, just a claim from whoever says they
 * received the money, timed and scoped tightly enough to be worth something
 * without pretending to be more than it is. See that module's header for
 * the full reasoning and docs/architecture/FIAT_CONFIRMATION.md for the
 * product-level tradeoffs.
 */
export function solanaRecipientConfirmationBinder(
  lookup: ConfirmationLookup,
  opts?: EvaluateOptions,
): FiatLegProofBinder {
  return createRecipientConfirmationBinder<TokenBalanceDelta>(
    "solana",
    lookup,
    (t) => ({ reference: t.signature, observedAt: t.observedAt }),
    opts,
  );
}
