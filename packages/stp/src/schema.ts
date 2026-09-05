import { z } from "zod";

/**
 * The honesty ladder (MULTICHAIN.md §4). Never inflate: a DERIVED event must
 * never be rendered as if it were PROVEN.
 *
 * - PROVEN    — read directly off an immutable, publicly replayable ledger
 *               with standardized events (Stellar only, today).
 * - ATTESTED  — backed by a signed, independently verifiable cross-chain
 *               artifact (e.g. a Circle CCTP burn + Iris attestation).
 * - DERIVED   — visible on-chain transfer bound to an off-chain proof of a
 *               custodial fiat leg (e.g. zkTLS / Proof-of-Reserve).
 */
export const EvidenceTier = z.enum(["PROVEN", "ATTESTED", "DERIVED"]);
export type EvidenceTier = z.infer<typeof EvidenceTier>;

export const Direction = z.enum(["deposit", "withdrawal", "bridge_in", "bridge_out"]);
export type Direction = z.infer<typeof Direction>;

const DECIMAL_STRING = /^\d+(\.\d+)?$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Every field the signature covers. `sig` itself is deliberately excluded —
 * see canonical.ts and sign.ts — because a field can't sign over itself.
 */
export const StpAttestationUnsigned = z.object({
  stp_version: z.literal("1"),
  anchor_id: z.string().min(1),
  chain: z.string().min(1),
  asset: z.string().min(1),
  direction: Direction,
  amount: z.string().regex(DECIMAL_STRING, "amount must be a decimal string, e.g. \"12.5\""),
  onchain_ref: z.string().min(1),
  fiat_leg_ref: z.string().nullable(),
  /** Mandatory, and must match reality — see MULTICHAIN.md §3 design rules. */
  evidence_tier: EvidenceTier,
  evidence_detail: z.string().min(1),
  /** Stellar tx hash this settlement roots to, when it touches the keystone chain. */
  keystone_ref: z.string().nullable(),
  observed_at: z.string().regex(ISO_8601, "observed_at must be ISO-8601 UTC, e.g. 2026-09-03T12:00:00Z"),
  /** Landfall attester key id. */
  signer: z.string().min(1),
});
export type StpAttestationUnsigned = z.infer<typeof StpAttestationUnsigned>;

export const StpAttestation = StpAttestationUnsigned.extend({
  sig: z.string().min(1),
});
export type StpAttestation = z.infer<typeof StpAttestation>;

/** Throws a descriptive ZodError if `value` is not a well-formed attestation. */
export function parseStpAttestation(value: unknown): StpAttestation {
  return StpAttestation.parse(value);
}
