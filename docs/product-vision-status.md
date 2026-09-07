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
| **AI Investigator** | ❌ Not built | No LLM reads reports or ledger activity and writes an analysis. This is the one module in "the complete product" slide with nothing behind it yet |
| **Intent Engine** | ✅ Shipping | `packages/intents/src/solve.ts` + `plan.ts` — `solveIntent()` picks a route, `buildPlan()` turns it into ordered steps, each carrying an explicit actor (`user`/`wallet`/`anchor`/`landfall`) so a plan can never imply Landfall executes anything |
| **Route Engine** | ✅ Shipping | Same package — cost/reliability/liquidity-ranked routing, `sortBy: "verified"` mode ranks evidence ahead of price. See `docs/architecture/VERIFIED_ROUTES.md` |
| **Agent Gateway** | ⚠️ Partial | MCP server ships (`scripts/mcp/server.mjs`, 9 tools — see below); no SDK on npm yet; no x402 wiring |

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
| Analyzed | ❌ No AI reads the report and explains a pattern. This is "AI Investigator" from the module slide, same gap |
| Reviewed | ✅ Dispute path exists — `PATCH /api/v1/fraud-reports/:id/dispute`, gated on a signature from the reported address, per `DISPUTES.md` |
| Attested | ⚠️ Reports are stored and disputable; no cryptographic attestation is generated over a report+dispute pair the way settlement events are |

**Sentinel as named in the deck does not exist as one system.** Report,
Observe and Review are real and working; Analyze is the missing piece that
would turn three working parts into the thing the deck describes.

---

## Landfall for AI agents — x402

**Positioning only, no integration.** README and ROADMAP both name x402 and
explain why it matters (Stellar joined the x402 Foundation in July 2026,
which answers "can an agent pay?" and leaves "who should it pay?" open —
exactly the question Trust Check answers). No code speaks x402 today: no
facilitator wiring, no spending-limit integration, nothing that lets an x402
payment flow actually call Trust Check before it settles.

The pieces x402 integration would need already exist independently —
Trust Check's API, the MCP server, the Intent Engine's plan output — so this
is closer to "assemble what's built" than "build from nothing." It just
hasn't been assembled.

---

## End state — infrastructure, not only a website

| Layer | Status |
|---|---|
| **Web app** | ✅ Live at [landfall-chi.vercel.app](https://landfall-chi.vercel.app) |
| **API** | ✅ REST (`api/[...path].js`) + GraphQL (`POST /api/v1/graphql`) |
| **SDK** | ⚠️ Built, tested, packaged (`packages/sdk`) — verified working from a real installed tarball outside this repo. **Not published to npm** — needs the `@landfall` scope created and `npm publish` run, both account actions |
| **MCP server** | ✅ `scripts/mcp/server.mjs` — **9 tools**, correctly listed in full in `docs/MCP.md`: `landfall_anchors`, `landfall_anchor_detail`, `landfall_payments`, `landfall_assets`, `landfall_corridors`, `landfall_health`, `landfall_trust_check`, `landfall_fraud_reports`, `landfall_intent`. (`docs/gaps.md`'s "six tools" entry is a dated 14 August record, from before the last three shipped — correctly left as the historical record it is, not a live count) |
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

1. **Publish `@landfall/sdk` to npm.** Code-complete, tested, verified. Blocked
   on `npm login` + creating the `@landfall` scope — both need you.
2. **AI Investigator / the "Analyzed" stage of Sentinel.** The one module
   named in the deck with nothing behind it. Report/Observe/Review already
   work; this is the missing fourth piece.
3. **Get one external consumer of anything** — a wallet calling
   `pickAnchor()`, an agent calling the MCP server. This is the actual bar
   the roadmap sets for "infrastructure," and nothing here can close it
   without an outside party adopting it.
4. **Mainnet oracle.** Rehearsed and verified on testnet; needs funded keys —
   your call on timing and custody of the admin key.
5. **x402 assembly.** Lower priority than the above because it's mostly
   wiring existing pieces together, not new capability — but it's the
   specific "Landfall for AI agents" module and currently has zero code.
6. **Registry stays empty** (`registry/anchors.registry.json`) — every
   non-Stellar chain reports `unresolved`. Needs anchor outreach to get a
   verified address, not code; a guessed one would misattribute settlement.

Execution/PAY is not on this list. It's excluded on purpose, not forgotten.
