# SEP and CAP coverage

Which Stellar standards Landfall actually uses, what it uses each one *for*,
and — the part usually left out — which ones it deliberately does not
implement.

The distinction that matters throughout: Landfall is an **observer**, not a
participant. It never plays the anchor side of a SEP, never plays the wallet
side, and never completes a transfer flow. Where a SEP appears below, it is
almost always being *read* rather than *served*.

---

## Used, in code

| Standard | What it is | What Landfall does with it | Where |
|---|---|---|---|
| **SEP-1** | `stellar.toml` at a home domain | The discovery root. Resolves a domain to the accounts it *claims* to operate, permissionlessly and with no cooperation. Everything downstream hangs off this | `packages/indexer/src/toml.ts` |
| **SEP-24** | Interactive deposit / withdrawal | Not implemented — **read as evidence**. SEP-24 puts one leg of every deposit and withdrawal on the public ledger, which is why settlement behaviour is already there retroactively for every anchor | `packages/indexer` |
| **SEP-10** | Stellar web authentication | **Implemented, server side.** Anchor operators authenticate by proving control of an account instead of with a password. Challenge is unsubmittable (sequence 0), single-use, and the signature is checked against the account's *medium* threshold | `api/_lib/sep10.js` |
| **SEP-38** | Firm quotes (RFQ) | Queried hourly against each tracked anchor's quote server, so a rate shown on Route Scout can be a real quote rather than a catalogue estimate. Coverage today is near zero — stated per anchor rather than hidden | `scripts/fetch-anchor-quotes.mjs` |
| **SEP-6** | Programmatic deposit / withdrawal | Capability probe only: does the TOML declare `TRANSFER_SERVER`, and does that endpoint actually answer? | `scripts/probe-capabilities.mjs` |
| **SEP-12** | KYC / customer data | Capability probe only. **No PII ever touches Landfall** — it checks whether a `KYC_SERVER` is declared and reachable, nothing more | `scripts/probe-capabilities.mjs` |
| **SEP-31** | Cross-border, anchor-to-anchor | Capability probe only: declared versus observed. "Declares SEP-31 and it works" and "declares SEP-31 and it doesn't" are two different facts, and only the ledger settles which | `scripts/probe-capabilities.mjs` |

### The declared-versus-observed probe

SEP-6, SEP-12 and SEP-31 exist here for one purpose: a TOML *declaring* a
service and that service *answering* are separate claims, and the gap between
them is itself a finding. `scripts/probe-capabilities.mjs` records both and
never collapses them — a declared endpoint that refuses connections is
reported as exactly that, not silently dropped and not treated as absent.

---

## Ready, not running

| Standard | State |
|---|---|
| **CAP-67** (Protocol 23) | Unified event ingestion — `ledger_events` in the schema is shaped on the CAP-67 topics, and the design is documented in [architecture.md](architecture.md). **Nothing ingests from it yet**; the REST cursor path is still what runs. Moving over replaces N per-account cursors with one ledger-wide stream and makes mint/burn distinguishable from transfer instead of inferred |

---

## Deliberately not implemented

| Standard | Why not |
|---|---|
| **SEP-24 / SEP-6 as a participant** | Completing a deposit or withdrawal means holding a key or a session with one — custody. Landfall reads the settlement legs these produce; it never initiates one. See [VERIFIED_ROUTES.md](architecture/VERIFIED_ROUTES.md) |
| **SEP-31 as a sending anchor** | Same reason. Landfall observes anchor-to-anchor settlement; being one is a different business with a different risk profile |
| **SEP-12 as a data holder** | Handling KYC means holding PII. Landfall stores none, and the probe above is deliberately capped at "is a server declared and does it respond" |
| **SEP-40** (price oracle interface) | The Soroban oracle publishes a *dataset digest and liveness state*, not prices. Shaping it as SEP-40 would imply it answers "what is this asset worth", which it does not and should not |

---

## Non-SEP Stellar primitives

| Primitive | Use |
|---|---|
| **Horizon** | The only ingestion path today: `/accounts/:id/payments`, paged with resumable cursors |
| **Soroban** | The on-chain oracle — publishes a digest per scan plus a liveness state per account, so a contract routes on the same data a wallet reads. Deployed to testnet; not on mainnet. **Immutable by design** — no upgrade entry point, and `storage_version()` declares the schema so a new version means a new address rather than changed semantics at the old one |
| **Account thresholds & signers** | Both SEP-10 login and the oracle's authority model check the account's **medium** threshold — the same bar Soroban's built-in account contract applies to `require_auth()`, so an account that is multisig for contract calls is multisig for logging in too |
| **Ed25519 signatures** | Fraud-report disputes are gated on a signature from the reported address. A dispute proves control of an account; it never asks for a key |
| **Stroops (BigInt)** | All money arithmetic. `toStroops`/`fromStroops` are the only conversion path, so no aggregate volume figure can drift through float rounding |

---

## The rule behind all of it

A SEP that requires Landfall to hold a key, hold funds, or hold personal data
is one Landfall does not implement. Everything above is either read from
public data or proves control of something the counterparty already owns.
