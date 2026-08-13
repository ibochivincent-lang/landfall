# What Landfall doesn't have yet

An honest inventory as of 12 August 2026. Ordered by how much each gap could
hurt, not by how hard it is to fix.

---

## 0. The one that matters most: the site now promises things that don't exist

The landing page currently advertises:

| Claim on the site | Reality |
|---|---|
| "Get API access" | There is no API |
| Pricing: $99/mo, 250k calls | Nothing to bill for, no billing |
| `@landfall/sdk` with `pickAnchor()` | Not written, not published to npm |
| "Log in" | No accounts, no auth, no database |
| "Webhooks when an anchor goes dark" | No webhooks |
| "MCP server for agents" | Not built |
| "1,000 API calls / month" free tier | No calls to make |
| Contact form | Submits to nothing |

**This is the exact flaw we identified in stellar-intel** — a landing page
claiming 70 anchors tracked while the code probed 7. We criticised it, then
built the same thing.

It matters more here than it would for most projects, because Landfall's entire
pitch is that it doesn't overstate. A reviewer who clicks "Get API access" and
finds nothing has learned something about how much to trust the 6-of-13 figure.

**Fix before anyone important sees it.** Cheapest honest option: keep the
sections, mark them clearly. "Coming in Q4" on pricing, "Join the waitlist"
instead of "Log in", "Planned" on the SDK block. Costs an hour and removes the
whole problem. The alternative is deleting those sections until they're real.

---

## 1. Product — nothing runs on its own

- **No scheduled scanning.** Someone has to open PowerShell and run the CLI.
  Nothing updates by itself.
- **The site's data is frozen.** Figures are hardcoded from one scan. A visitor
  in October sees August data presented as current, with no "as of" freshness
  indicator anywhere near the numbers.
- **No database.** Every run writes a JSON file. Nothing accumulates, so there
  are no trends, no history, no "this anchor has been dark for N consecutive
  scans", no alerting on state change.
- **No API, no SDK, no MCP server, no Soroban oracle** — Layers 2 and 3 of the
  architecture are designed and unbuilt.
- **No attestation layer**, so no slippage metric. The most valuable number the
  project could produce does not exist yet.
- **No dispute portal**, despite the code of conduct and security policy both
  promising anchors a route to challenge a figure.

## 2. Data quality — known weaknesses

- **Refund detection is still a heuristic.** Memo correlation (backlog M1) is
  the fix and it isn't done. Every return figure carries this caveat.
- **The fiat leg is invisible.** We cannot tell whether money reached anyone.
  Documented, unavoidable without attestation.
- **Account attribution is unverified.** A TOML declares accounts; nothing
  proves the domain operates them. This is the single largest correctness risk.
- **Only 5 domains resolve.** 8 candidates, 3 failed. The Stellar ecosystem has
  far more anchors than this, so "6 of 13" is a real finding about a small
  sample, not a census of the ecosystem.
- **`vibrantapp.com` is unexplained** — served a TOML, parser found no accounts.
  Probably our bug, still uninvestigated.
- **One dormancy figure is approximate** (`GDKL…LMT6`, shown as ≈34.6d).
- **Single-region indexing.** One vantage point, though this matters far less
  for ledger reads than it would for probing.
- **No confidence intervals** on any rate.

## 3. Repo and process

- **The 16 issues are still unfiled** — deliberately, but it's the gate on
  applying to the Wave.
- **Not under an organisation.** Eight of ten approved Wave repos are.
- **Not applied to the Stellar Wave.**
- **No contributors, no PRs, no external commits.**
- **No releases or tags.** No version has ever been cut.
- **Nothing published to npm.**
- **CI has never been proven green** on a real PR — it's configured, but no
  pull request has exercised it.

## 4. Grant and business

- **The SCF interest form is not submitted.** Deadline 16 August. This is the
  only item in the entire project with a hard deadline, and it's the cheapest
  one on this list.
- **Team backgrounds are unwritten.** Five names, no evidence behind any of them.
- **Part-time vs full-time unstated**, which the $50k budget arithmetic depends on.
- **No users. No wallet conversations. No revenue. No letters of support.**
- **Pricing is invented.** $99/month is a plausible-sounding number nobody has
  tested against a real buyer.

## 5. Site polish

- **No `og:image`** — the meta tag points at nothing, so shared links render bare.
- **No analytics**, so no idea whether anyone visits.
- **No custom domain.**
- **Chart and table need JavaScript.** The hero and stats are static, but the
  data itself won't render for a crawler or a no-JS reader.
- **No accessibility audit.** Keyboard nav, focus traps in the modal, and
  contrast on the yellow background have not been checked properly.
- **No 404 page.**
- **Fonts come from Google**, which is a third-party request on every load and
  a privacy consideration worth a thought.

## 6. Legal and operational

- **No privacy policy or terms**, and the contact form collects names and emails.
- **No stated position on the obvious risk**: publishing negative findings about
  named financial businesses. The code of conduct covers tone; nothing covers
  what happens if an anchor's lawyer writes in.
- **No backup of scan history.** Delete `out/` and the record is gone.

---

## If you only do four things

1. **Mark the aspirational parts of the site as planned** — one hour, removes
   the credibility problem this list opens with
2. **Submit the SCF interest form** — Saturday, and it's three answers already
   written
3. **File the 16 issues and apply to the Wave** — one script run
4. **Automate the scan** so the site's numbers stop being a snapshot of one
   afternoon

Everything else can wait. The first two are the ones with a clock on them.
