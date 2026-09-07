# Product Vision — status against the plan

Checked against the two vision decks (`Landfall_01_Product_Vision.pdf`,
`Landfall_02_How_It_Works.pdf`) module by module, verified against the
running code rather than restated from memory. Same rule as everywhere else
in this repo: a claim here should be checkable against a file path, a live
endpoint, or a test — and where something in the deck isn't built, it says
so plainly rather than being quietly dropped from the list.

Last checked: 7 September 2026.

---

## The pipeline — CHECK · INTENT · RISK · ROUTE · PAY · VERIFY · ATTEST

| Stage | Status | Where |
|---|---|---|
| **CHECK** | ✅ Shipping | `/trust-check.html`, `GET /api/v1/trust-check` — ledger-only counterparty signals |
| **INTENT** | ✅ Shipping | `packages/intents` — `solveIntent()`, `POST /api/v1/intent` |
| **RISK** | ✅ Shipping | Trust Check's flags + score; Route Scout's reliability grade |
| **ROUTE** | ✅ Shipping | `packages/intents`' verified-routing mode, `/compare.html` |
| **PAY** | ❌ Not built, deliberately | See [Execution — the one box left empty on purpose](#execution--the-one-box-left-empty-on-purpose) below |
| **VERIFY** | ✅ Shipping | `packages/anchoring` — Merkle inclusion proofs, per-account, published hourly |
| **ATTEST** | ⚠️ Partial | `packages/stp` signs when a key is configured; unsigned digest otherwise. No production signing key set |

---

## The complete product — six modules from the deck

| Module | Status | Where |
|---|---|---|
| **Trust Check** | ✅ Shipping | `/trust-check.html` — paste an address or tx hash, get history/concentration/forwarding signals, a transparent 0–100 score, confidence rating |
| **Fraud Reports** | ✅ Shipping, minus review | `POST /api/v1/fraud-reports` — every report must cite a tx hash Landfall verifies exists and involves the subject before storing it. Reports render on the Trust Check page, kept in their own card, never blended into the score |
| **AI Investigator** | ⚠️ Shipping, narrative needs a key | `packages/investigator`, `POST /api/v1/fraud-reports/:id/investigate` — cited facts and relevant Trust Check signals are deterministic and always computed, with no AI. The narrative half is optional AI prose over exactly those facts, and is `null` whenever `OPENAI_API_KEY` isn't configured — no key is set in production yet, so today every investigation returns facts with no narrative |
| **Intent Engine** | ✅ Shipping | `packages/intents/src/solve.ts` + `plan.ts` — `solveIntent()` picks a route, `buildPlan()` turns it into ordered steps, each carrying an explicit actor (`user`/`wallet`/`anchor`/`landfall`) so a plan can never imply Landfall executes anything |
| **Route Engine** | ✅ Shipping | Same package — cost/reliability/liquidity-ranked routing, `sortBy: "verified"` mode ranks evidence ahead of price. See `docs/architecture/VERIFIED_ROUTES.md` |
| **Agent Gateway** | ⚠️ Partial | MCP server ships (`scripts/mcp/server.mjs`, 11 tools — see below); SDK published to npm ([`@landfall/sdk`](https://www.npmjs.com/package/@landfall/sdk)); x402 payee-safety check wired (`packages/x402`), no facilitator — see below, on purpose |

---

## Trust before payment — the first consumer product

| Step | Status |
|---|---|
| **1. Check** | ✅ Paste a wallet or tx hash, get a risk view — `/trust-check.html` |
| **2. Explain** | ✅ Every flag names its evidence and links the transaction hashes behind it |
| **3. Protect** | ❌ No pre-signature warning exists — there is nothing between Trust Check and a wallet's own signing flow yet. Needs a wallet integration, not just an API |

The deck's own instruction — *"report evidence and confidence, not claim
that an AI model can prove [something]"* — is enforced today by having no AI
model in this path at all. `packages/trust-check/src/analyze.ts`'s score is
arithmetic over named flags, each traceable to a ledger fact; nothing is
inferred by a model.

---

## Landfall Sentinel — the AI fraud agent

| Stage | Status |
|---|---|
| Reported | ✅ `POST /api/v1/fraud-reports` |
| Observed | ✅ The cited tx hash is verified against the ledger before the report is stored — fabricated or unrelated evidence is rejected, not filed |
| Analyzed | ⚠️ `POST /api/v1/fraud-reports/:id/investigate` computes deterministic cited facts and relevant Trust Check signals for the report, with no AI. It also asks a model for a plain-language narrative of exactly those facts — but no `OPENAI_API_KEY` is configured in production yet, so the narrative half returns `null` until one is set |
| Reviewed | ✅ Dispute path exists — `POST /api/v1/fraud-reports/:id/dispute`, gated on a signature from the reported address, per `DISPUTES.md` |
| Attested | ⚠️ Reports are stored and disputable; no cryptographic attestation is generated over a report+dispute pair the way settlement events are |

**Sentinel as named in the deck does not fully exist as one system yet.**
Report, Observe, Analyze (its deterministic half) and Review are real and
working; what's missing is a configured model key to turn Analyze's
narrative half on, and the Attest stage.

---

## Landfall for AI agents — x402

**Assembled for the one question Landfall can answer, not the whole protocol.**
`packages/x402`, `POST /api/v1/x402/check-payee`, and the `landfall_x402_check_payee`
MCP tool take the real `accepts` array from an x402 402 response (matched
against x402-foundation/x402's own spec — CAIP-2 network ids, the
`PaymentRequirements` shape) and run Trust Check against every Stellar
G-account `payTo` before an agent signs. An entry on another chain, or a
Soroban contract Trust Check can't attribute to an operator, comes back
`supported: false` with a stated reason rather than being silently dropped.

What this deliberately does not do: verify or settle a payment. That is a
facilitator's job — Stellar has one (SDF partnered with OpenZeppelin for
audited spending-limit contracts; [stellar.org/x402](https://stellar.org/x402))
— and building a second one here would mean holding or routing funds during
settlement, which this project has refused to do anywhere else. So "x402
assembly" is accurate as a description of scope, not as a claim of
completeness: the counterparty-safety half is wired; the payment-execution
half was never going to be built here, on purpose, same as Execution/PAY
below.

---

## End state — infrastructure, not only a website

| Layer | Status |
|---|---|
| **Web app** | ✅ Live at [landfall-chi.vercel.app](https://landfall-chi.vercel.app) |
| **API** | ✅ REST (`api/[...path].js`) + GraphQL (`POST /api/v1/graphql`) |
| **SDK** | ✅ Published — [`npm install @landfall/sdk`](https://www.npmjs.com/package/@landfall/sdk). Verified 7 September against the real registry copy, not just the local build: installed fresh into a scratch project outside this repo, ran the README's `pickAnchor()` example, 12 PROVEN correctly outranked 900 DERIVED |
| **MCP server** | ✅ `scripts/mcp/server.mjs` — **11 tools**, correctly listed in full in `docs/MCP.md`: `landfall_anchors`, `landfall_anchor_detail`, `landfall_payments`, `landfall_assets`, `landfall_corridors`, `landfall_health`, `landfall_trust_check`, `landfall_fraud_reports`, `landfall_investigation`, `landfall_x402_check_payee`, `landfall_intent`. (`docs/gaps.md`'s "six tools" entry is a dated 14 August record, from before the rest shipped — correctly left as the historical record it is, not a live count) |
| **Wallets** | ❌ Zero external wallet integrations. Nothing outside this repo calls any of the above yet |
| **Agents** | ❌ Same — no external MCP/agent consumer confirmed |
| **Stellar** | ⚠️ Soroban oracle deployed to **testnet only**. `scripts/publish-oracle.mjs` verified publishing real digests end to end (6 September dry run). **Not on mainnet** — needs funded keys, which is your call, not a code blocker |

**The infrastructure test the roadmap itself sets** — *"Landfall is
infrastructure once external systems depend on it... today nothing outside
this repo depends on it yet"* — **is still unmet.** Everything above is real
and independently checkable; none of it yet has an external consumer.

---

## Execution — the one box left empty on purpose

The vision deck's user-experience flow ends at *"prepares the payment for
the user to [execute]"* — cut off in the source PDF, but the direction is
clear: eventually, pay.

This repo has deliberately not built that. `docs/architecture/VERIFIED_ROUTES.md`
declined an "Execute route" button on Route Scout for the same reason
`plan.ts`'s `StepActor` type never assigns a money-moving step to
`"landfall"`: **executing a payment means holding a key or a session with
one, which means custody.** That is a different risk category from
everything else in this repo — indexing a public ledger needs no
permission and can't lose anyone's money; moving funds can. It's a
deliberate, standing decision, not an oversight, and reversing it needs an
explicit decision from the account owner, not a feature request answered
in passing.

---

## What's actually left, in priority order

~~Publish `@landfall/sdk` to npm.~~ **Done, 7 September** —
[`npm install @landfall/sdk`](https://www.npmjs.com/package/@landfall/sdk)
works, verified against the live registry copy.

~~AI Investigator / the "Analyzed" stage of Sentinel.~~ **Code done, 7
September** — `packages/investigator`, `POST /api/v1/fraud-reports/:id/investigate`,
`landfall_investigation` MCP tool. Cited facts and Trust Check signals are
deterministic and live now; the AI narrative needs `OPENAI_API_KEY` set in
production, which is not done yet — until then every investigation returns
facts with a `null` narrative, which is the module's documented degrade
path, not a bug.

~~x402 assembly.~~ **Code done, 7 September** — `packages/x402`,
`POST /api/v1/x402/check-payee`, `landfall_x402_check_payee` MCP tool. Runs
Trust Check on every Stellar G-account payee in a real x402 `accepts` array
before an agent signs. Deliberately does not verify or settle a payment —
that stays the facilitator's job, not this repo's, the same custody line
`plan.ts` and `VERIFIED_ROUTES.md` already draw.

1. **Set `OPENAI_API_KEY` in production**, or decide not to — the narrative
   half of AI Investigator is otherwise finished code waiting on a key and a
   decision about that cost, not an engineering gap.
2. **Get one external consumer of anything** — a wallet calling
   `pickAnchor()`, an agent calling the MCP server (including the new x402
   payee check). This is the actual bar the roadmap sets for
   "infrastructure," and nothing here can close it without an outside party
   adopting it. Publishing the SDK is a precondition for this, not the
   milestone itself — nobody has installed it yet.
3. **Mainnet oracle.** Rehearsed and verified on testnet; needs funded keys —
   your call on timing and custody of the admin key.
4. **Registry stays empty** (`registry/anchors.registry.json`) — every
   non-Stellar chain reports `unresolved`. Needs anchor outreach to get a
   verified address, not code; a guessed one would misattribute settlement.

Execution/PAY is not on this list. It's excluded on purpose, not forgotten.
