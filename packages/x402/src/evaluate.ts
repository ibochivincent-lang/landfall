import type { PayeeAssessment, PaymentRequirements } from "./types.js";

/** CAIP-2 ids x402's own Stellar mechanism package defines — mirrors x402-foundation/x402's packages/mechanisms/stellar/src/constants.ts. */
const STELLAR_NETWORKS = new Set(["stellar:pubnet", "stellar:testnet"]);

/** Classic Stellar account only — mirrors the G-account branch of x402's STELLAR_DESTINATION_ADDRESS_REGEX. Trust Check reads G-account payment history; it has no way to attribute a Soroban contract (C...) or muxed account (M...) to an operator. */
const G_ADDRESS = /^G[A-Z2-7]{55}$/;

/**
 * Runs `runTrustCheck` against every `payTo` this module can actually
 * assess, and explains — never hides — every one it can't. Kept generic
 * over the Trust Check result type and the fetch function so this stays
 * pure and independently testable; the caller wires in the real
 * `trustCheckFetchInput` + `analyzeTrustCheck` pair.
 */
export async function evaluatePaymentRequirements<TrustCheckResult>(
  accepts: PaymentRequirements[],
  runTrustCheck: (address: string) => Promise<TrustCheckResult>,
): Promise<PayeeAssessment<TrustCheckResult>[]> {
  return Promise.all(
    accepts.map(async (requirement): Promise<PayeeAssessment<TrustCheckResult>> => {
      if (!STELLAR_NETWORKS.has(requirement.network)) {
        return {
          requirement,
          supported: false,
          reason: `network "${requirement.network}" is not Stellar — Trust Check reads Stellar ledger history only.`,
        };
      }
      if (!G_ADDRESS.test(requirement.payTo)) {
        return {
          requirement,
          supported: false,
          reason: `payTo "${requirement.payTo}" is not a classic Stellar account (G...) — likely a Soroban contract or muxed address, which Trust Check cannot attribute to an operator.`,
        };
      }
      const trustCheck = await runTrustCheck(requirement.payTo);
      return { requirement, supported: true, trustCheck };
    }),
  );
}
