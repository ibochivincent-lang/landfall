import type { Trc20Transfer } from "./trongrid.js";
import {
  createRecipientConfirmationBinder,
  type ConfirmationLookup,
  type EvaluateOptions,
} from "../../src/fiatConfirmation.js";


export type FiatLegProofKind = "zktls" | "proof_of_reserve" | "recipient_confirmation";

export interface FiatLegProof {
  kind: FiatLegProofKind;
  /** Reference to the off-chain proof artifact (a proof id, an attestation id) — never the raw fiat account/receipt data itself. */
  ref: string;
}

/**
 * Binds a Tron USDT transfer to the off-chain proof that makes it DERIVED
 * evidence rather than a bare, unattributed transfer (MULTICHAIN.md §4).
 * A real implementation wraps a zkTLS provider (e.g. a proof of a
 * custodial exchange's withdrawal API response) or a Proof-of-Reserve
 * feed. That integration is future work (§10 step 8) — this interface is
 * what TronAdapter is built against so it can be plugged in later without
 * changing the adapter itself.
 */
export interface FiatLegProofBinder {
  /** Resolves to a proof once one is available for this transfer, or null if none has been bound (yet, or ever). */
  bind(transfer: Trc20Transfer): Promise<FiatLegProof | null>;
}

/**
 * The honest default: binds nothing. Without a real proof integration,
 * TronAdapter should emit zero events rather than present a bare transfer
 * as DERIVED evidence it hasn't earned — see TronAdapter.scan().
 */
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
export function tronRecipientConfirmationBinder(
  lookup: ConfirmationLookup,
  opts?: EvaluateOptions,
): FiatLegProofBinder {
  return createRecipientConfirmationBinder<Trc20Transfer>(
    "tron",
    lookup,
    (t) => ({ reference: t.transactionId, observedAt: t.observedAt }),
    opts,
  );
}
