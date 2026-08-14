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
which made this list wrong the moment it shipped. This section covers
everything closed on 14 August, from three independent passes over the same
commit that landed within hours of each other.

| Was | Now |
|---|---|
| No GraphQL API | `/api/v1/graphql`, reusing the REST resolvers directly — `docs/GRAPHQL_API.md` |
| "MCP server for agents" advertised, not built | `scripts/mcp/server.mjs`, six tools, verified against a real database with the MCP SDK's own client — `docs/MCP.md` |
| `forgot-password` returned the reset token to anyone who asked — account takeover | Fixed in two stages: first (5218da3) the token stopped leaving the server at all — logged for manual admin relay, since no email sender existed. Then real delivery was wired up: the token is now emailed via Resend, never returned in the response, and both the found/not-found branches share identical wording — full detail below. |
| An incremental scan published one hour's payments as the anchor's whole record, and graded named anchors on it | Metrics computed over persisted history plus the new fetch. Fetch stays incremental, arithmetic is cumulative again — full detail below. |
| No rate limiting on any auth endpoint | A Postgres-backed counter now throttles login, register, forgot-password, reset-password, and admin login (10/min/IP each). |
| Password policy was a 6-character minimum only | Raised to 10 characters plus a common-password check. |
| Webhook registration only string-checked for `https://` | Now resolves the target hostname and blocks private/loopback/link-local/cloud-metadata IP ranges, re-checked again immediately before every delivery (registration-time-only checking leaves a DNS-rebinding gap). |
| "Webhooks when an anchor goes dark" — still none, nothing consumes the `dark` event | `scripts/dispatch-webhooks.mjs` runs after every hourly scan, diffs liveness state, and HMAC-signs + POSTs to registered webhooks on transition into `dark`. |
| API keys were generated but never checked anywhere | Now enforced as a rate-limit tier: a valid key raises the public-read limit to that key's configured `rate_limit_per_min`; anonymous requests get a conservative default. **Reads are still fully public either way** — a key changes the rate, not access. This is not the metered/billed tier described below; that's still not built. |
| "the indexer does not publish to it — so it is a deployed contract, not a working oracle" | `scripts/publish-oracle.mjs` runs after every scan (once `ORACLE_CONTRACT_ID`/`ORACLE_ADMIN_SECRET` are configured) and calls `publish(digest)`. Still **not on mainnet**. |

### The scan published an hour as though it were a history — 14 August 2026

Between the 07:00 and 08:00 hourly scans, every published figure quietly
changed meaning. The numbers, straight from the scan commits:

| Scan | Total inbound | Total outbound |
|---|---|---|
| 07:00 UTC | 4,039 | 2,099 |
| 08:00 UTC | 4 | 0 |
| 09:00 UTC | 1 | 0 |

Nothing about the ledger changed. `d90d6a8` made a cursor-resumed scan fetch
only what was new since the last run — correct, and the reason an hourly scan
can finish in seconds — but metrics were still computed from whatever that run
happened to fetch. So `inbound`, which had always meant "payments this account
has ever received", started meaning "payments in the last hour" while keeping
the same name, the same field, and the same place on the site.

The damage was not the empty dashboard. It was that the Anchor Reliability
Score kept computing, and published **ntokens.com at 10/100, mykobo.co at
30/100, cowrie.exchange at 40/100** — real, named financial businesses graded
near-zero on evidence that was never gathered. A project whose entire pitch is
"we don't overstate, and the ledger is the proof" spent roughly two hours
publicly rating companies on a dataset containing one payment.

**Fixed** by computing metrics over persisted history plus the new fetch rather
than the fetch alone (`packages/indexer/src/history.ts`). The fetch stays
incremental, so the speed win is kept; the arithmetic goes back to being
cumulative. Verified against a real Postgres database: an account with 300
persisted payments receiving one new one now reports 301, not 1.

Three further things surfaced while fixing it:

- **A failed Horizon page was silently swallowed.** The paging loop caught
  errors and `break`ed, returning a short record set indistinguishable from a
  complete one. SECURITY.md names that exact behaviour — "causing the indexer
  to silently drop records rather than report a gap" — as the worst class of
  bug this project can have. Errors now propagate; the account is dropped from
  the run with a loud log line instead of publishing an undercount.
- **The resume cursor was tracked by position, not by time.** It took the last
  record of the last page, which is the *oldest* record under the `order=desc`
  used by a first full scan. Now chosen by timestamp, which is correct under
  both orderings.
- **Two tests were already failing on `main`** and had been pushed anyway.
  Both are green again. CI runs `npm test`, so this was visible and went
  unread — worth a look at why.

### Found while building the GraphQL API and MCP server

- **`corridors` was a shipped, broken feature.** `GET /api/v1/corridors` and
  the new GraphQL `corridors` field both query a `corridors` table that no
  migration ever created and no indexer code ever wrote — the README claimed
  "Settlement corridors API + dashboard: shipping" while the endpoint threw
  `relation "corridors" does not exist` on any correctly migrated database.
  Fixed with `006_corridors_view.sql`, a view derived from the
  `source_asset`/`asset` columns `003_path_payments.sql` already added —
  verified against a real database both before the fix (error) and after
  (correct aggregated rows from seeded path-payment data).
- **`packages/api/src/server.ts` (local dev API) is now meaningfully behind
  `api/[...path].js` (the deployed API).** A teammate shipped the Developer
  Portal, reliability scoring, health-check, badges, and corridors straight
  to the deployed function without updating local dev. Rather than rush a
  backport of someone else's large feature set under the SCF deadline, the
  new GraphQL layer and MCP server both import directly from
  `api/[...path].js` — the file actually running in production — so they're
  correct today, but `npm run api` (local dev) does not yet reflect any of
  this. Whoever picks this up next should treat it as a real backport task,
  not a quick sync.

---

## Found and fixed, 14 August 2026: a real account-takeover path in the Developer Portal

`POST /api/v1/auth/forgot-password` (added with the Developer Portal,
`005_developer_portal.sql`) used to return the password-reset token directly
in the JSON response body instead of emailing it:

```js
return adminJson(res, 200, {
  ok: true,
  resetToken, // Returned for instant in-portal reset demonstration
  message: 'Password reset code generated. Use it below to set your new password.'
});
```

Anyone who submitted an email address — their own, a guessed one, or one
scraped from anywhere — got back a valid token to reset that account's
password on the spot, with no verification the requester controlled the
email. A second, smaller issue sat next to it: the "no account found" branch
returned a different message than the "found" branch, which let a caller
enumerate registered emails even without the token leak. Both found while
reading `api/[...path].js` to build the GraphQL/MCP layer on top of it, not
introduced by that work.

**Fix:** the endpoint now returns the exact same generic message whether or
not the account exists, and never returns the token. ~~There's no email
sender wired up anywhere in this project yet, so for now the token is logged
server-side only (readable by the team via Vercel logs, not returned to the
caller) and an admin has to relay it to the account owner out-of-band~~ —
~~Self-serve reset is temporarily manual rather than fully automated.~~
~~Wiring up an actual transactional email sender (Resend, SES, or similar) is
the real fix and isn't done — track it as a follow-up, not as closed.~~

**Update, same day:** that follow-up is done. The token is now emailed via
Resend (`api/_lib/email.js`), never logged in full and never returned in the
response; the Developer Portal's "Forgot password" flow
(`packages/web/portal.html`, `portal.js`) says "check your email" instead of
describing a manual admin relay. Self-serve reset is fully automated again —
requires `RESEND_API_KEY` and a `FROM_EMAIL` on a domain verified with
Resend to actually deliver; without them the send fails loudly (logged, not
silent), it does not fall back to the old behavior.

---

## 0b. Closed 14 August: the landing page never showed live data

The hero card badged itself `STELLAR LEDGER · LIVE` and displayed
**"Observed volume $1,876,580"**, animated counting up on load. It was a
constant in `app.js`:

```js
const TARGET_VOLUME = 1876580;
```

Nothing ever replaced it, and no endpoint publishes a volume total, so there
was no real figure to replace it with. A single dollar number could not be
honest anyway — the indexed assets are ARS, USDC, EURC, XLM, NGNT, BRL and PEN,
and summing them into one currency needs FX rates this project does not have
and will not invent.

Underneath it, the page's live wiring had been broken since it was written, in
two independent ways:

```js
.then(b => render(b.anchors || b.data || b))   // b.accounts is the array; this passes the whole object
const data = accounts.map(a => ({ status: a.status || ... }))   // API sends `state`, never `status`
```

The first threw `accounts.map is not a function`; the second would have
classified every account as `none` had the first been fixed alone. Both errors
landed in `.catch(() => {})`, so the page silently fell back to the hardcoded
numbers in the HTML and no one saw a failure. Every figure a visitor read —
including the "6 of 13" headline — was typed, not fetched. It happened to be
right, because someone updated it by hand.

**Fixed:** the fetch passes `b.accounts`, `render()` reads `state`, and the card
now reports **inbound settlements indexed** — a number computed from the same
rows the dashboard shows, which the project can actually prove. The scan date
is driven from the payload's `asOf` instead of a string typed into the HTML, so
a page that calls itself live can no longer date itself by hand. The empty
`.catch` now warns to the console: a silent catch is how both bugs survived.

The static fallbacks baked into `index.html` are now rewritten by the hourly
scan itself (`scripts/scan-to-api.mjs`), so the date, account count, settlement
count and dark figure stay correct for a crawler, a reader with JS off, or
anyone hitting the page while the API is down. Previously those were typed by
hand and drifted — the site was two days stale about its own freshness under a
"LIVE" badge. The scan already knows the right numbers; now it writes them.

## 0c. Closed 14 August: the contact form discarded messages

`preventDefault()`, show a green tick, `reset()`. Nothing was sent anywhere.
The message had already been made honest ("Nothing was actually sent"), but it
told visitors to "email us directly" and the project publishes no email address
anywhere.

That matters most for the one visitor this project owes a reply to: an anchor
disputing a figure published about it. CODE_OF_CONDUCT and SECURITY both
promise that route.

**Fixed:** the form now opens a pre-filled GitHub issue — the channel
CONTRIBUTING and SECURITY already name, and one that demonstrably works —
with security reports pointed at a private advisory instead. Inventing a
support address would have been the same lie in a different place.

---

## 0a. Open and live: Route Scout publishes invented rates and fees

Found 14 August, unfixed at time of writing. This is the most serious open item
on this page.

`/compare.html` headlines itself:

> "Compare every integrated Stellar anchor by payout, fees, speed, and
> **verified on-chain settlement reliability** — before routing a payment."

and footers "Settlement reliability derived from the public Stellar ledger — no
anchor self-reporting."

The reliability column is real and does come from the ledger. Everything beside
it does not. `GET /api/v1/quotes/compare` returns a hardcoded catalogue that
lives in the source:

```js
const fxRates = { NGN: 1610.50, KES: 129.80, GHS: 15.65, /* ... */ };
{ name: 'Cowrie Exchange', rateSpread: 0.998, feePercent: 0.8,
  feeFixedUsd: 0.50, payoutSpeed: 'Instant (1–3 mins)' }
{ name: 'MoneyGram Access', rateSpread: 0.995, feePercent: 0.0,
  feeFixedUsd: 0.00, payoutSpeed: 'Cash in 5 mins' }
```

Nothing fetches these. There is no SEP-38 call anywhere in the codebase despite
the commit message describing the feature as shipping "with SEP-38 quotes". The
FX rates are static, so they are also wrong by however much the market has moved
since they were typed.

Why this is worse than the reliability bug fixed the same day: those scores were
at least computed from real ledger records, and the failure was a window that had
silently narrowed. These are commercial terms — a 0.8% fee, a $0.50 charge, a
0% fee for MoneyGram, a 1–3 minute payout — asserted about named financial
businesses, on a page that says "verified" and "no anchor self-reporting", with
no disclaimer anywhere. A user could route real money on them. A competitor
could reasonably call it misrepresentation.

It also reproduces, exactly, the flaw section 0 below says we criticised
stellar-intel for and then committed ourselves.

**Two honest fixes, either acceptable:**

1. Label the rate, fee and speed columns as illustrative until SEP-38 ingestion
   lands, and change the headline so "verified" clearly scopes to reliability
   only.
2. Ship the reliability comparison alone and add the commercial columns when
   there is a real quote behind them.

The second is stronger. Landfall's whole claim is that it publishes only what
the ledger proves, and a rate table is precisely the kind of anchor-supplied
number the project exists to distrust.

---

## Also closed 14 August: password-reset delivery, rate limiting, webhooks, oracle publish

Three more things closed the same day, on top of what's above:

- **`forgot-password` — real delivery.** 5218da3 (above) stopped the token
  leaving the server, but left resets manual: the token was logged
  server-side for an admin to relay by hand, since no email sender existed.
  That gap is now closed too — the token is emailed via
  [Resend](https://resend.com), never returned in the response, and the
  found/not-found responses share identical wording. Requires
  `RESEND_API_KEY` and a `FROM_EMAIL` on a domain verified with Resend to
  actually deliver; without them the send fails loudly (logged, not silent).
- **No rate limiting on any auth endpoint.** A Postgres-backed counter
  (`rate_limit_counters`) now throttles login, register, forgot-password,
  reset-password, and admin login at 10/min/IP each. Also raised the
  password minimum from 6 to 10 characters plus a common-password check.
- **Webhooks were entirely inert.** `user_webhooks` rows were stored but
  nothing ever fired one, and registration only string-checked the URL
  started with `https://` — no protection against a target that resolves to
  a private/loopback/link-local/cloud-metadata address. Both fixed:
  `api/_lib/net-guard.js` resolves and blocks those ranges at registration
  *and* again immediately before every delivery (a registration-time-only
  check leaves a DNS-rebinding gap), and `scripts/dispatch-webhooks.mjs` now
  runs after every hourly scan, diffs liveness state account-by-account, and
  HMAC-signs + POSTs to every active, subscribed webhook when an account
  transitions into `dark`, with retry/backoff and a delivery audit trail
  (`webhook_deliveries`).
- **API keys were generated but never checked.** Now enforced as a
  rate-limit tier: a valid `x-api-key` raises the public-read limit to that
  key's own `rate_limit_per_min`; no key (or an invalid one) gets a
  conservative anonymous default. **Reads stay fully public either way** —
  a key changes the rate, not access. This is not the metered/billed tier
  described below in section 0; that's still not built.
- **The oracle was deployed but never published to.** `scripts/publish-oracle.mjs`
  now runs after every scan, computes a digest over the scan's account
  summaries, and calls the deployed contract's `publish()` — once
  `ORACLE_CONTRACT_ID`/`ORACLE_ADMIN_SECRET` are configured as secrets; it
  no-ops cleanly (logged, not silent) until then. Still **not on mainnet**.

---

## 0. The one that mattered most: the site promising things that don't exist

The landing page advertised a product that was not there. Most of it is now
either real or labelled; what remains is listed as **still aspirational**.

| Claim on the site | Reality, 13 August |
|---|---|
| "Get API access" | The API exists and is documented. There is now a real key-issuing Developer Portal (see 14 August table above) — but a key only buys a higher rate limit, it doesn't gate access, so "get access" still overstates it a little. |
| Pricing: $99/mo, 250k calls | **Still invented.** Nothing to bill for, no billing, no buyer has seen the number. |
| `@landfall/sdk` with `pickAnchor()` | **Still not written**, not on npm. Labelled planned. |
| ~~"Log in"~~ | ~~Still no accounts, no auth.~~ Real auth shipped 14 August — see the tables above. |
| ~~"Webhooks when an anchor goes dark"~~ | ~~Still none.~~ Dispatcher shipped 14 August — see the tables above. |
| "MCP server for agents" | Built — `scripts/mcp/server.mjs`, `docs/MCP.md`. Not linked from the site, and no external agent has connected to it yet. |
| "1,000 API calls / month" free tier | There are calls to make now, and `rate_limit_per_min` is now enforced per key as of 14 August — but that's an anti-abuse limit, not a metered/billed tier. Still no metering, still no tier. |
| ~~Contact form~~ | ~~Still submits to nothing.~~ Fixed 14 August — see 0c above. |

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
- ~~**No API**~~ — shipped. ~~**No MCP server.**~~ — shipped, unlinked from
  the site, no external consumer yet. **Still no SDK.**
- **No live quote data.** Route Scout compares rates and fees from a hardcoded
  table (section 0a). Until SEP-38 ingestion exists, every commercial figure on
  that page is invented, and `pickAnchor()` cannot be built on top of it —
  optimising over fabricated inputs returns a confident answer with nothing
  behind it.
- **No predictive signal.** Every scan is stored, so the data to detect an
  anchor degrading before it goes dark exists and nothing reads it back. A
  wallet would rather have 48 hours' warning than an accurate post-mortem.
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
