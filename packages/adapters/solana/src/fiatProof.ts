import type { TokenBalanceDelta } from "./rpc.js";

export type FiatLegProofKind = "zktls" | "proof_of_reserve";

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
