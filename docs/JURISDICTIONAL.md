# Regulatory and legal posture

**This is not legal advice.** It is the reasoning the project operates on,
written down so it can be checked, argued with, or corrected by someone
qualified. If you are that person and something here is wrong, that is a
valuable issue to file.

`docs/gaps.md` has carried "no stated position on legal pushback" as an open
risk since August. This is that position.

---

## 1. Why this is not money transmission

Money transmission regimes — FinCEN's MSB rules in the US, the EU's VASP
framework, and their equivalents — attach to **receiving, holding, or
transmitting value on behalf of another person**.

Landfall does none of those:

| Test | Landfall |
|---|---|
| Receives funds from a user | No |
| Holds funds for a user | No |
| Transmits funds to a third party | No |
| Custody of user keys | No |
| Acts as intermediary in a transfer | No |

There is no account funds pass through, and no code path that submits a
value-moving transaction. The enforcement is described in
[NON_CUSTODY.md](NON_CUSTODY.md).

**What Landfall does instead** is read a public ledger and publish
observations about it. That is closer to a search engine or a financial-data
publisher than to a payments business — and the ledger it reads is public,
permissionless, and requires no relationship with any party being described.

**The honest caveat:** "we do not custody" is a necessary condition, not
automatically a sufficient one in every jurisdiction. Some regimes attach to
facilitating or advising on transfers regardless of custody. This project's
answer is the same either way — it does not execute, does not advise on
specific transactions, and publishes observations rather than
recommendations.

---

## 2. The sharper risk: publishing about named businesses

The money-transmission question is comparatively easy. **The real exposure is
defamation.** Landfall publishes statements about named, identifiable
companies — that an anchor has not settled in 30 days, that an account's
volume is concentrated, that someone filed a report about it. A negative
finding about a real business is precisely the kind of statement that attracts
a lawyer's letter.

The defences are built into the product rather than bolted on:

**Truth, and the ability to demonstrate it.** Every published figure is
derived from public ledger records and recomputable by any third party from
Horizon, using arithmetic documented in [methodology.md](methodology.md). A
claim that is independently verifiable by the complainant's own engineers is a
different position from one resting on proprietary analysis.

**Statements of fact, carefully bounded.** Landfall says what the ledger
shows, and repeatedly refuses to say what it means. `dark` means no observed
on-chain settlement in 30 days — it explicitly does *not* mean the anchor has
failed, and the API, the site and the docs all say so in the same breath. An
issuer account that never moves, a rotated account still declared in a stale
TOML, and an operator who has genuinely stopped all look identical from the
ledger, and that ambiguity is published alongside the finding.

**No inferred intent.** Nothing in the system says an operator is fraudulent,
negligent, or insolvent. Flags are ledger facts with evidence hashes attached;
Trust Check's own text says *"a flag is a ledger fact, never an accusation"*
and notes that the same pattern that looks like risk is also an ordinary
automated wallet.

**A right of reply that costs the subject nothing.** [DISPUTES.md](../DISPUTES.md)
and the signature-gated dispute path let a reported party attach a response
that travels with the report wherever it appears. Landfall does not adjudicate
between the two and says so.

**Sample limits stated, not buried.** Coverage is a curated set, not a census,
and every place a figure appears says so.

---

## 3. Third-party fraud reports — the highest-risk surface

A fraud report is an anonymous stranger publishing an allegation about a named
party. This is the most legally loaded thing in the repository, and the design
constraints are correspondingly strict — see
`packages/fraud-reports/src/types.ts`:

1. **Attributed to the reporter, never to Landfall.** There is no field
   anywhere that lets Landfall endorse a report's truth, because no process
   here could establish it.
2. **Evidence is mandatory and verified.** Every report must cite a
   transaction that exists on the ledger *and* involves the subject, checked
   before storage. Unverifiable reports are rejected outright, not stored at
   low weight.
3. **Volume is never a verdict.** No score is computed from report counts.
   Three reports is three strangers, which may be three victims or one person
   with three browsers.
4. **No "confirmed" state exists.** The strongest status is `reviewed` — a
   human read it and the evidence checked out, not that the allegation is
   true.
5. **The subject can always answer**, by signature, and the answer is attached
   to the accusation rather than filed somewhere nobody looks.

**Intermediary protections may apply** to user-submitted content in some
jurisdictions, but this project does not rely on them as its primary defence.
The design assumes it is responsible for what it publishes and constrains what
it publishes accordingly.

---

## 4. Data protection

**No personal data is collected about the people Landfall describes.** Stellar
account addresses are pseudonymous public identifiers already published on an
open ledger; Landfall attributes them to a domain only where the domain's own
SEP-1 TOML declares them.

| Data | Handling |
|---|---|
| Ledger data | Public, permissionless. No relationship with any subject |
| KYC / PII | **None held.** SEP-12 is probed for existence only — see [SEP_COVERAGE.md](SEP_COVERAGE.md) |
| Portal accounts | Email and a scrypt-hashed password, for API-key management |
| Reporter IP | Stored as a **hash**, to limit duplicate filings — not as an address |
| Fraud report text | Stored verbatim, attributed to the reporter, deletable on a withdrawn report |

If you are a person rather than a business and believe an address describing
you should not be indexed, the dispute path in [DISPUTES.md](../DISPUTES.md) is
the route to raise it.

---

## 5. What is genuinely unresolved

Stated because a legal page listing only comfortable conclusions is not one.

- **No jurisdiction of establishment is declared.** The project is operated by
  an individual; it has no company, no registered address, and no stated
  governing law. That is a real gap if it ever takes payment or signs a
  contract.
- **No legal review has been obtained.** Nothing here has been checked by a
  qualified lawyer in any jurisdiction.
- ~~**No policy for a takedown demand.**~~ Written:
  [TAKEDOWN.md](TAKEDOWN.md). It separates a correction (the figure is wrong —
  treated as a bug, always welcome) from a takedown (the figure is right and
  someone would rather it were not visible — declined, with reasons), states
  that a court order with jurisdiction would be complied with, and commits to
  recording *that* a compelled removal happened even where the content cannot
  be restated. **Untested** — no takedown has ever been received, which is
  exactly why it was written in advance.
- **Account attribution is unverified.** A TOML declares accounts; nothing
  proves the domain operates them. A wrong attribution means a finding about
  the wrong business — the one error that happens *before* the arithmetic and
  which `evidence_tier` cannot catch. It is the largest correctness risk in
  the project and a legal risk for the same reason.
- **The paid tier does not exist**, so no consumer-protection or contractual
  obligations attach yet. Introducing one changes this page.

---

## 6. Position, in one line

Landfall publishes independently verifiable observations about public ledger
activity, holds nothing belonging to anyone, states the limits of every figure
in the same place as the figure, and gives anyone it describes a way to answer
back.

If that turns out to be legally insufficient somewhere, the response is to fix
the practice and correct this page — not to remove the finding.

---

## Related

- [NON_CUSTODY.md](NON_CUSTODY.md) — the architectural constraint
- [DISPUTES.md](../DISPUTES.md) — right of reply
- [methodology.md](methodology.md) — recomputable arithmetic
- [TRUST.md](TRUST.md) — what you must trust
- [gaps.md](gaps.md) — where this was flagged as open
