import { StrKey } from "@stellar/stellar-base";
import type { PayeeAssessment, PayeeCheckOutcome, PaymentRequirements, SupportedPayee } from "./types.js";

/** CAIP-2 ids x402's own Stellar mechanism package defines — mirrors x402-foundation/x402's packages/mechanisms/stellar/src/constants.ts. */
const STELLAR_NETWORKS = new Set(["stellar:pubnet", "stellar:testnet"]);

const G_ADDRESS = /^G[A-Z2-7]{55}$/;
const M_ADDRESS = /^M[A-Z2-7]{68}$/;
const C_ADDRESS = /^C[A-Z2-7]{55}$/;

/**
 * Resolves a Stellar address to its inspectable base account.
 * Unwraps Muxed Accounts (M...) into their base Ed25519 public key (G...) and extracts
 * the 64-bit memo ID. Identifies Soroban contract addresses (C...).
 */
export function unwrapStellarAddress(payTo: string): {
  address: string;
  isMuxed: boolean;
  memoId?: string;
  isContract: boolean;
  isValid: boolean;
} {
  const clean = String(payTo ?? "").trim();
  if (G_ADDRESS.test(clean)) {
    return { address: clean, isMuxed: false, isContract: false, isValid: true };
  }
  if (M_ADDRESS.test(clean)) {
    try {
      if (StrKey.isValidMed25519PublicKey(clean)) {
        const raw = StrKey.decodeMed25519PublicKey(clean);
        const ed25519Raw = raw.subarray(0, 32);
        const memoId = raw.readBigUInt64BE(32).toString();
        const baseAccount = StrKey.encodeEd25519PublicKey(ed25519Raw);
        return { address: baseAccount, isMuxed: true, memoId, isContract: false, isValid: true };
      }
    } catch {
      // Fall through if parsing fails
    }
  }
  const isContract = C_ADDRESS.test(clean) || (typeof StrKey.isValidContract === "function" && StrKey.isValidContract(clean));
  return { address: clean, isMuxed: false, isContract, isValid: false };
}

/**
 * Runs `runTrustCheck` against every `payTo` this module can actually
 * assess, and explains — never hides — every one it can't. Kept generic
 * over the Trust Check result type and the checker so this stays pure and
 * independently testable; the caller wires in the real
 * `trustCheckFetchInput` + `analyzeTrustCheck` pair.
 *
 * Every requirement always gets exactly one assessment, in input order, and
 * one payee's failure never removes another's answer.
 */
export async function evaluatePaymentRequirements<TrustCheckResult>(
  accepts: PaymentRequirements[],
  runTrustCheck: (address: string) => Promise<PayeeCheckOutcome<TrustCheckResult>>,
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

      const unwrapped = unwrapStellarAddress(requirement.payTo);
      if (unwrapped.isContract) {
        return {
          requirement,
          supported: false,
          isContract: true,
          reason: `payTo "${requirement.payTo}" is a Soroban contract (C...) — Trust Check evaluates entity payment history on ledger accounts (G.../M...), not contract bytecode.`,
        };
      }

      if (!unwrapped.isValid) {
        return {
          requirement,
          supported: false,
          reason: `payTo "${requirement.payTo}" is not a valid classic or muxed Stellar account (G... or M...).`,
        };
      }

      const outcome = await runTrustCheck(unwrapped.address);
      if (!outcome.ok) {
        return { requirement, supported: false, reason: outcome.reason, retryable: outcome.retryable };
      }

      const res: SupportedPayee<TrustCheckResult> = {
        requirement,
        supported: true,
        trustCheck: outcome.trustCheck,
      };
      if (unwrapped.isMuxed) {
        res.isMuxed = true;
        res.baseAccount = unwrapped.address;
        if (unwrapped.memoId) res.memoId = unwrapped.memoId;
      }
      return res;
    }),
  );
}
