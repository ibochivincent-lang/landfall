/**
 * Recipient confirmation — the weakest of the three ways to close the
 * REAL WORLD PAYMENT → ATTESTATION gap (docs/architecture/FIAT_CONFIRMATION.md).
 *
 * Tron and Solana are DERIVED-tier: a visible on-chain transfer bound to an
 * off-chain proof of the custodial fiat leg it triggers. Both adapters ship
 * with NULL_FIAT_LEG_BINDER, which binds nothing, because until now nothing
 * implemented that proof. The two strong options — an anchor-signed receipt,
 * or zkTLS over the bank notification — either need a counterparty's
 * cooperation or are hard to build. This is the one that needs neither: the
 * person who actually received the money says so.
 *
 * That is also its whole weakness, and it is not hidden. Nothing here
 * authenticates the respondent — there is no login, no signature, no
 * identity binding of any kind. A submission is one HTTP request with a
 * string. What keeps it from being worthless rather than merely weak is
 * narrow and explicit:
 *
 *   - it must name the exact on-chain transfer it claims to confirm
 *     (`reference`), so it cannot be reused across events;
 *   - it must come from someone claiming to be the RECIPIENT, not the
 *     sender — the sender already knows their own intent, which is not
 *     evidence the money arrived (see "sender-not-binding" below);
 *   - it must arrive in a bounded window after the transfer, timed by the
 *     server's own clock, never the client's;
 *   - a storage-layer uniqueness constraint (chain, reference) makes each
 *     transfer confirmable exactly once — see docs/architecture/FIAT_CONFIRMATION.md
 *     for why first-submission-wins is a real limitation, not just a detail.
 *
 * None of that adds up to identity. It adds up to "a specific claim, about a
 * specific event, made once, in a plausible window" — which is real
 * evidence, of a kind this codebase's tier system already has a name for:
 * DERIVED, evidence_detail spelling out exactly how thin it is.
 */

/** What the respondent says happened. Only "received" can ever bind — see evaluateConfirmation. */
export type ConfirmationOutcome = "received" | "not_received" | "partial";

/** The proof kind this module produces, for FiatLegProofKind unions. */
export const RECIPIENT_CONFIRMATION_KIND = "recipient_confirmation" as const;

export interface ConfirmationClaim {
  chain: string;
  /** The on-chain transfer this confirms — must equal the transfer's own id/signature. */
  reference: string;
  /**
   * Self-declared, unauthenticated. Only "recipient" can ever produce
   * binding evidence: the sender already knows whether they intended to
   * pay, which says nothing about whether the money arrived.
   */
  respondent: "recipient" | "sender";
  outcome: ConfirmationOutcome;
  /** What they say arrived, in their own currency/words. Never checked against the on-chain amount — different currency, different units, informational only. */
  reportedAmount?: string;
  reportedCurrency?: string;
  /** Free text, stored verbatim, trusted no more than the rest of the claim. */
  note?: string;
  /**
   * Set by the server clock on receipt — NEVER accept this from the client.
   * A client-supplied timestamp would let a stale or premature claim dress
   * itself up as timely, which is exactly the one check this scheme can
   * still make.
   */
  submittedAt: string;
}

export interface NormalizedTransfer {
  reference: string;
  observedAt: string;
}

export type ConfirmationRejection =
  | "reference-mismatch"
  | "too-early"
  | "too-late"
  | "sender-not-binding"
  | "not-received";

export interface EvaluateOptions {
  /** How long after the transfer a confirmation is still eligible to bind. Default 30 days — long enough for someone to notice and report, short enough that "confirming" a year-old transfer is treated as what it is: not really about that transfer anymore. */
  maxAgeDays?: number;
}

export interface EvaluatedConfirmation {
  ok: boolean;
  reason?: ConfirmationRejection;
  proof?: { kind: typeof RECIPIENT_CONFIRMATION_KIND; ref: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure. Takes the claim, the transfer it claims to be about, and the
 * server's own read of "now" already baked into `claim.submittedAt" — does
 * no I/O and trusts no clock but the one the caller already applied.
 */
export function evaluateConfirmation(
  claim: ConfirmationClaim,
  transfer: NormalizedTransfer,
  opts: EvaluateOptions = {},
): EvaluatedConfirmation {
  if (claim.reference !== transfer.reference) {
    return { ok: false, reason: "reference-mismatch" };
  }

  // The sender already knows whether they intended to pay. That is not
  // evidence the recipient got anything — it is the fact this whole scheme
  // exists to get evidence about. A sender's own claim is recorded (it may
  // be useful context elsewhere) but it never becomes a FiatLegProof.
  if (claim.respondent !== "recipient") {
    return { ok: false, reason: "sender-not-binding" };
  }

  // A truthful "no" or "partial" must never produce a positive proof. This
  // binder only ever upgrades evidence tier; it has no mechanism for
  // asserting a settlement failed, and forcing that through this path would
  // silently drop the negative signal rather than surface it.
  if (claim.outcome !== "received") {
    return { ok: false, reason: "not-received" };
  }

  const submitted = Date.parse(claim.submittedAt);
  const observed = Date.parse(transfer.observedAt);
  const maxAgeMs = (opts.maxAgeDays ?? 30) * DAY_MS;

  // Confirming receipt of something before it happened is not a timing
  // detail — the claim cannot be about this transfer.
  if (submitted < observed) {
    return { ok: false, reason: "too-early" };
  }
  if (submitted - observed > maxAgeMs) {
    return { ok: false, reason: "too-late" };
  }

  return {
    ok: true,
    proof: { kind: RECIPIENT_CONFIRMATION_KIND, ref: `${claim.chain}:${claim.reference}` },
  };
}

/** Reads back the one confirmation claim (if any) submitted for a given transfer. */
export interface ConfirmationLookup {
  find(chain: string, reference: string): Promise<ConfirmationClaim | null>;
}

/**
 * Builds a `FiatLegProofBinder`-shaped object (`{ bind(transfer) }`) for any
 * chain, given a way to turn that chain's native transfer type into the
 * `{ reference, observedAt }` shape evaluateConfirmation needs.
 *
 * Generic over the adapter's own transfer type so this one implementation
 * serves Tron's `Trc20Transfer` and Solana's `TokenBalanceDelta` (and any
 * future DERIVED-tier adapter) without either adapter depending on the
 * other's types.
 */
export function createRecipientConfirmationBinder<TTransfer>(
  chain: string,
  lookup: ConfirmationLookup,
  extract: (transfer: TTransfer) => NormalizedTransfer,
  opts: EvaluateOptions = {},
): { bind(transfer: TTransfer): Promise<{ kind: typeof RECIPIENT_CONFIRMATION_KIND; ref: string } | null> } {
  return {
    async bind(transfer: TTransfer) {
      const normalized = extract(transfer);
      const claim = await lookup.find(chain, normalized.reference);
      if (!claim) return null;
      const result = evaluateConfirmation(claim, normalized, opts);
      return result.ok ? result.proof! : null;
    },
  };
}
