# What Landfall doesn't have yet

An honest inventory as of 12 August 2026, amended 13 August, amended again
14 August. Ordered by how much each gap could hurt, not by how hard it is to
fix.

Closed items are struck through rather than deleted. A gap list that only ever
shrinks silently is a changelog wearing a disguise, and the point of this page
is that it can be checked against the repository.

---

## Closed since this list was written — 13 August 2026

| Was | Now |
|---|---|
| No database | Postgres schema, 12 tables, applied and verified. `--persist` writes to it. |
| No API | Read-only HTTP API, eight endpoints, every response carrying `asOf` and `staleHours`. |
| Site data frozen, no freshness indicator | Both pages read the API live and stamp the scan age. |
| No transaction-level view | `/dashboard` — every indexed payment per anchor, each row linked to its hash on a block explorer. |
| No scheduled scanning | `docker-compose.prod.yml` runs the indexer on a loop; `docs/deployment.md` covers running it as a real cron job instead. |
| No deployment path | Supabase, production compose, Vercel proxy, and a contract deploy script. `docs/deployment.md`. |
| Site promised an API, pricing, login, SDK that did not exist | Marked planned. The API now exists; the rest is still labelled. |

Two defects were found and published while doing this, in keeping with the
rule that we hold ourselves to what we measure in others:

- `docker-compose.yml` passed `--persist` to a flag the indexer did not
  implement. It ran every fifteen minutes, printed a clean report, and wrote
  nothing to the database. Silently.
- `vercel.json` still pointed at the pre-restructure directory. The next
  deploy would have served a 404.

---

## Closed since this list was written — 14 August 2026

The Developer Portal commit (multi-user auth, API keys, webhooks, password
reset) landed the same day this list still said "no accounts, no auth" —
which made this list wrong the moment it shipped. Fixed here, along with
what a security/readiness pass on that commit found.

| Was | Now |
|---|---|
| "Log in" — still no accounts, no auth | Portal auth shipped: register/login/session cookies, scrypt-hashed passwords. |
| `forgot-password` returned the raw reset token in the API response | **This was a live account-takeover bug** — anyone who knew a victim's email could read the token off the response and reset their password with no further interaction. Fixed: the token is now only ever emailed (via Resend), never returned in the response, and the found/not-found responses are worded identically. |
| No rate limiting on any auth endpoint | A Postgres-backed counter now throttles login, register, forgot-password, reset-password, and admin login (10/min/IP each). |
| Password policy was a 6-character minimum only | Raised to 10 characters plus a common-password check. |
| Webhook registration only string-checked for `https://` | Now resolves the target hostname and blocks private/loopback/link-local/cloud-metadata IP ranges, re-checked again immediately before every delivery (registration-time-only checking leaves a DNS-rebinding gap). |
| "Webhooks when an anchor goes dark" — still none, nothing consumes the `dark` event | `scripts/dispatch-webhooks.mjs` runs after every hourly scan, diffs liveness state, and HMAC-signs + POSTs to registered webhooks on transition into `dark`. |
| API keys were generated but never checked anywhere | Now enforced as a rate-limit tier: a valid key raises the public-read limit to that key's configured `rate_limit_per_min`; anonymous requests get a conservative default. **Reads are still fully public either way** — a key changes the rate, not access. This is not the metered/billed tier described below; that's still not built. |
| Contact form — still submits to nothing | `POST /api/v1/contact` now sends via Resend and records every submission in `contact_messages`, so a failed send is visible instead of a fake "sent!" toast. |
| "the indexer does not publish to it — so it is a deployed contract, not a working oracle" | `scripts/publish-oracle.mjs` runs after every scan (once `ORACLE_CONTRACT_ID`/`ORACLE_ADMIN_SECRET` are configured) and calls `publish(digest)`. Still **not on mainnet**. |

---

## 0. The one that mattered most: the site promising things that don't exist

The landing page advertised a product that was not there. Most of it is now
either real or labelled; what remains is listed as **still aspirational**.

| Claim on the site | Reality, 13 August |
|---|---|
| "Get API access" | The API exists and is documented. There is now a real key-issuing Developer Portal (see 14 August table above) — but a key only buys a higher rate limit, it doesn't gate access, so "get access" still overstates it a little. |
| Pricing: $99/mo, 250k calls | **Still invented.** Nothing to bill for, no billing, no buyer has seen the number. |
| `@landfall/sdk` with `pickAnchor()` | **Still not written**, not on npm. Labelled planned. |
| ~~"Log in"~~ | ~~Still no accounts, no auth.~~ Real auth shipped 14 August — see the table above. |
| ~~"Webhooks when an anchor goes dark"~~ | ~~Still none.~~ Dispatcher shipped 14 August — see the table above. |
| "MCP server for agents" | **Still not built.** |
| "1,000 API calls / month" free tier | There are calls to make now, and `rate_limit_per_min` is now enforced per key as of 14 August — but that's an anti-abuse limit, not a metered/billed tier. Still no metering, still no tier. |
| ~~Contact form~~ | ~~Still submits to nothing.~~ Sends via Resend as of 14 August — see the table above. |

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

- ~~**No scheduled scanning.**~~ The production compose file loops; a real
  scheduler is documented and preferred. **Still nothing running anywhere** —
  the stack is deployable, not deployed.
- ~~**The site's data is frozen.**~~ Both pages read live and show scan age.
- ~~**No database.**~~ Postgres, persisted, resumable.
- **No trend history in the product.** Every scan is stored, so the data for
  "dark for N consecutive scans" exists — nothing reads it back yet, and there
  is still no alerting on state change.
- ~~**No API**~~ — shipped. **No SDK, no MCP server.**
- ~~**The Soroban oracle has never been deployed.**~~ Live on **testnet** at
  `CA2IYHFKTKSJWR5IICY6HFD55BJEGE7OMKISWMLMPFSHLESZYO3VICAG` as of
  13 August 2026. ~~The indexer does not publish to it.~~ `scripts/publish-oracle.mjs`
  now does, once configured — see the 14 August table above. Still **not on
  mainnet**.
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

- ~~**The 20 issues are unfiled.**~~ Filed 13 August 2026, issues #4-#23.
  **Not yet applied to the Wave** - that is now the open step.
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
- **Fonts come from Google**, which is a third-party request on every load and
  a privacy consideration worth a thought.

## 6. Legal and operational

- **No privacy policy or terms**, and the contact form collects names and emails.
- **No stated position on the obvious risk**: publishing negative findings about
  named financial businesses. The code of conduct covers tone; nothing covers
  what happens if an anchor's lawyer writes in.
- **No backup of scan history beyond the host's own.** Supabase keeps seven
  days on the free tier. Nothing in this repo takes a `pg_dump`.
- **No alerting.** Nothing tells anyone the indexer stopped; `staleHours` in
  every API response is the manual substitute.

---

## If you only do four things

1. **Submit the SCF interest form.** Deadline 16 August. Part 1 of
   `docs/scf-submission.md` is ready to paste. Nothing else here has a clock.
2. **Apply the repo to the Stellar Wave in Drips.** The 20 issues are filed;
   the application is not made.
3. **Actually deploy something.** The stack is deployable and not deployed; a
   Supabase project and one container turn "designed" into "running", and it is
   an afternoon. `docs/deployment.md`.
4. **Deploy the oracle to testnet.** Sixteen passing tests against a simulated
   environment is not the same claim as a contract that exists.
   `./scripts/deploy-contract.sh testnet`

Everything else can wait. The first two are the ones with a clock on them.
