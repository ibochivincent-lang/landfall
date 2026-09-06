# Recipient Confirmation

## The gap

Every DERIVED-tier adapter (Tron, Solana) watches a real, visible, independently
checkable on-chain transfer. What it cannot watch is the fiat leg that transfer
is supposed to trigger — a bank deposit, a mobile money credit — because that
happens off-chain, inside a custodian nobody outside it can see into.

Both adapters have always shipped honest about this. `NULL_FIAT_LEG_BINDER`
binds nothing, so out of the box they emit zero events rather than present a
bare transfer as evidence it hasn't earned. Closing that gap needs an actual
`FiatLegProofBinder` implementation, and there are three ways to build one:

| Approach | Needs | Strength |
|---|---|---|
| Anchor-signed receipt | The anchor's cooperation | Strong |
| zkTLS over the bank API | Hard engineering, no cooperation needed | Strong |
| Recipient confirmation | Nothing — anyone can submit one | Weak |

This is the third one, built first because it is the only one that needed
nobody else's permission.

## What it actually proves

Not much, and that is stated everywhere it matters rather than smoothed over.
A submission is one HTTP request carrying a string. Nobody is authenticated —
no login, no signature, no identity binding of any kind. Anyone with the
transfer's reference can submit anything.

What keeps it from being worthless rather than merely weak is narrow and
enforced mechanically, not by trust:

- **Exact reference match.** A confirmation names the specific on-chain
  transfer it is about; it cannot be reused across events.
- **Recipient, never sender.** The sender already knows whether they intended
  to pay — that is not evidence the money arrived, which is the entire fact
  this scheme exists to learn. A sender's own report is stored (it may be
  useful context) but `evaluateConfirmation` never lets it produce a proof —
  see `sender-not-binding` in `packages/adapters/src/fiatConfirmation.ts`.
- **Timed by the server, not the client.** `submittedAt` is set from the
  request handler's own clock. A client-supplied timestamp would let a stale
  or premature claim dress itself up as timely, which is exactly the one
  check this scheme can still make honestly.
- **Once, ever.** `UNIQUE(chain, reference)` in
  `packages/db/migrations/008_fiat_confirmations.sql` means each transfer can
  be confirmed exactly once. There is no update path. Without that
  constraint, a second submission could overwrite a truthful "not received"
  with a false "received" — the exact tampering the rest of this design
  exists to resist.

None of that adds up to identity. It adds up to "a specific claim, about a
specific event, made once, in a plausible window" — which the tier system
already has a name for: **DERIVED**, with `evidence_detail` spelling out
exactly how thin it is. This never claims PROVEN or ATTESTED, and the code
has no path to let it.

## What it deliberately does not do

**It does not match the reported amount against the on-chain amount.** The
transfer is in USDC or USDT; the recipient reports what arrived in naira,
pesos, whatever the local currency is. Those are different units at a
floating exchange rate — comparing them numerically would produce a false
sense of precision. `reportedAmount` is stored and shown to a human, never
checked by code.

**It never asserts a negative.** `evaluateConfirmation` only ever upgrades a
transfer's evidence tier. A truthful "not received" or "partial" is recorded
but produces no proof either way — this binder has no mechanism for flagging
a settlement as failed, and forcing one through this path would silently
drop the negative signal rather than surface it somewhere it can be acted on.

**It does not check the amount at submission time against anything on-chain.**
The API layer that receives a submission (`POST /api/v1/fiat-confirmations` in
`api/[...path].js`) has no live connection to Solana or Tron RPC — adding one
per submission would be a real dependency for a small honesty gain. Instead,
the two rules that do not depend on chain state (respondent, outcome) are
checked immediately and returned as `eligible`/`ineligibleReason`, so a
submitter knows right away if their own claim can never bind. The two rules
that do depend on the transfer's own timestamp (`too-early`, `too-late`) are
evaluated later, by whichever process already has that timestamp —
`scripts/cross-chain-scan.ts`, at the moment it scans the transfer and asks
the binder for a proof.

## Where it lives

| | |
|---|---|
| `packages/adapters/src/fiatConfirmation.ts` | The pure logic — `evaluateConfirmation`, `createRecipientConfirmationBinder`. No I/O. |
| `packages/adapters/tron/src/fiatProof.ts`, `.../solana/src/fiatProof.ts` | Per-chain factories (`tronRecipientConfirmationBinder`, `solanaRecipientConfirmationBinder`) that adapt each adapter's native transfer shape into what the pure logic needs. |
| `packages/db/migrations/008_fiat_confirmations.sql` | The uniqueness constraint that makes "once, ever" real. |
| `scripts/lib/fiatConfirmationLookup.ts` | Postgres-backed `ConfirmationLookup`, used only by `scripts/cross-chain-scan.ts` when `DATABASE_URL` is set. |
| `api/[...path].js` | `POST /api/v1/fiat-confirmations` (submit), `GET /api/v1/fiat-confirmations/:chain/:reference` (status). |
| `packages/web/confirm.html` / `confirm.js` | The form a link sends someone to. |

**On the duplicated logic:** `api/[...path].js` has no build step — Vercel
runs `npm install` and nothing else — so it cannot import the TypeScript
package at runtime. `evaluateFiatConfirmation` there is a hand-written JS
mirror of `evaluateConfirmation`, the same situation `packages/web/intent.js`
is in against `packages/intents/src/solve.ts`, and it gets the same fix:
`packages/adapters/test/fiatConfirmationParity.test.ts` imports the actual
deployed API file and runs a shared fixture set through both implementations,
failing on any disagreement.

## Wiring it in

Without `DATABASE_URL`, both adapters behave exactly as before this existed —
`NULL_FIAT_LEG_BINDER`, zero DERIVED events. With it,
`scripts/cross-chain-scan.ts` builds one `ConfirmationLookup` backed by
Postgres and passes the matching binder to whichever adapter is scanning:

```ts
const confirmationLookup = createDbConfirmationLookup(pool);
new TronAdapter({ chain: "tron", fiatLegProofBinder: tronRecipientConfirmationBinder(confirmationLookup) });
```

A DERIVED-tier adapter with no lookup source is not a regression — it is the
same default both adapters shipped with, stated as loudly now as it was then.
