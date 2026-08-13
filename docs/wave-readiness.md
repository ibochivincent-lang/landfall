# Where Landfall stands in the Stellar Wave

Written 13 August 2026, after an adversarial audit of this repository and a
look at the cohort it is joining. Kept in the repo because the weaknesses
below are more useful to a contributor than a sales pitch.

---

## The cohort

The Stellar Wave has **666 approved repositories**. This is not a curated
shortlist of ten — it is a large pool competing for a shared points budget, and
admission is not the achievement. Featured repos carry a 4× multiplier and look
like this:

| Repo | What it is |
|---|---|
| `Trustless-Work/trustlesswork-smart-contract-stellar` | Permissionless escrow, Soroban + USDC |
| `stellopay/stellopay-core` | Decentralised payroll on Soroban |
| `kindfi-org/kindfi` | Web3 crowdfunding, milestone escrows |
| `Stellar-Rent/stellar-rent` | P2P rentals, no intermediaries |
| `safetrustcr/frontend-SafeTrust` | P2P escrow for tourism bookings |
| `OFFER-HUB/offer-hub-monorepo` | Freelance marketplace |
| `ritik4ever/stellar-portfolio-rebalancer` | Portfolio tooling |
| `akkuea/akkuea` | RWA + DeFi |

Rejection is real and expensive: an appeal cannot be filed for two weeks, then
carries a one-month cooldown, with three attempts maximum, and each requires
"substantive change." A weak application costs six weeks, not an afternoon.
Issues that are pre-assigned are blocked from Wave entry outright.

---

## Where Landfall is genuinely different

**1. It is infrastructure, not an application.** Almost every repo above is a
product with users — escrow, payroll, rentals, crowdfunding. Landfall produces
a *primitive* those products consume: a settlement-quality signal for the
anchors they route through. In a pool of 666 marketplaces and escrow services,
"measures whether the anchors all of you depend on are actually settling" is a
category of one.

**2. The data source is the differentiator, not the interface.** Existing anchor
monitors interrogate — ping an endpoint, validate a TOML, record the answer the
anchor chose to give. Landfall observes the ledger. This is not a UX
distinction; it changes what can be faked. A TOML edit takes ten seconds, two
years of settlement history cannot be forged.

**3. It has a published finding, not just a codebase.** 6 of 13 declared anchor
accounts dark for over 30 days, cross-checked against stellar.expert. Most Wave
repos ship capability. This ships a *result* about the ecosystem the Wave
belongs to — and one the Stellar Development Foundation has a direct interest
in knowing.

**4. It uses Stellar in a way that does not port.** SEP-1 for permissionless
discovery, SEP-24 for why the ledger is sufficient, CAP-67 for the unified
event stream, SEP-38 for a slippage baseline, Soroban for publication. Move it
to another chain and there is nothing left. Several repos in the cohort are
generic apps that happen to settle on Stellar.

**5. The self-criticism is unusual and load-bearing.** `docs/gaps.md` lists
what the project does not have, struck through rather than deleted as items
close. Two measurement defects were found in our own tool and published with
before-and-after numbers. For a project whose product is *judging other
people's reliability*, this is not decoration — it is the thing that earns the
standing to publish a name.

**6. Test and contribution hygiene is above the median.** 58 tests (37 offline
with a mock Horizon, 5 integration against real Postgres, 16 against the
contract), CI on two Node versions, issue templates, a code of conduct with a
project-specific clause about discussing named anchors factually, and a
security policy. Twenty issues with acceptance criteria, point-tagged.

---

## Where it is weaker than the cohort

**1. No users, no integrations, no traction.** Every featured repo above has
stars, forks, open issues and contributors. Landfall has one author and zero
external commits. In a program that rewards *contribution activity*, a repo
nobody has contributed to yet is a cold start.

**2. Nothing is running.** The stack is deployable and not deployed. The public
site serves a snapshot; `/dashboard` shows its "no API connected" panel. A
reviewer who visits expecting live anchor data finds a static page. The
competitors have deployed frontends.

**3. It measures rather than moves value.** That is the intellectual strength
and the commercial weakness. Escrow and payroll have obvious users who pay.
"Who consumes this, and why would they?" is the question to have an answer for,
and right now the answer is a planned SDK.

**4. Personal account, not an organisation.** Most of the cohort sits under an
org. This is cosmetic but it is the cosmetic thing reviewers notice.

**5. Small sample.** Five resolving domains. A real finding about a small
sample, not a census. Named as a risk in the SCF draft and the first thing a
sceptic will press on.

---

## Fixed during this audit

These were found, verified and repaired — not reported and left:

| Finding | Why it mattered |
|---|---|
| `npm ci` failed on a clean clone — `package-lock.json` was missing the `@landfall/api` workspace | CI was red on both Node versions, `docker compose up` died at two services, and the prod image could not build. Every documented way in was broken. |
| Front page published `3,974` and `0.13%` above a table summing to `4,631` and `0.108%` | The one arithmetic check a sceptical reader can run failed. Now derived from the data at render time so they cannot drift again. |
| Resume cursors documented as shipped in five places, never implemented | Honesty rule 6 is the one invariant the project asserts about itself. Now wired, with two regression tests. |
| No issue carried the `Stellar Wave` label | Drips selection depends on it, and the README told contributors it was there. |
| All 20 issue bodies linked `CONTRIBUTING.md` relatively | GitHub resolves that to `/issues/CONTRIBUTING.md`. Every new contributor's setup link 404'd. |
| Stale docs: test counts, a pre-monorepo source tree, "oracle never deployed", "issues unfiled" | Small individually; collectively they read as a repo nobody maintains. |

---

## Still open, in priority order

**Before applying to the Wave**

1. **Re-label the 20 filed issues.** The script is fixed; issues #4–#23 are
   already on GitHub without the label. One command:
   ```powershell
   4..23 | ForEach-Object { gh issue edit $_ --repo ibochivincent-lang/landfall --add-label "Stellar Wave" }
   ```
2. **Fix the dead CONTRIBUTING link in the 20 filed issue bodies**, or accept
   it — the script is corrected for future runs.
3. **Close issue #6** (`Support http:// Horizon URLs`). The premise is false:
   nothing in `cli.ts` or `horizon.ts` checks the scheme, and
   `docker-compose.yml` already passes `http://localhost:8000`. A contributor
   claiming it finds the work done. Only the README example is missing.
4. **Three issues are not startable without asking a question** — #18 (publish
   digests: the indexer has no Stellar SDK and no signing path, and the admin
   secret is deliberately outside the environment), #19/#20 (both accept on
   returning "confidence", which is defined nowhere), #8 (Freighter: the site
   is static with a `script-src 'self'` CSP and no way to add a dependency).
   Add the missing decision to each body.

**Before a grant reviewer visits**

5. **Deploy something.** Supabase plus one container turns the site from a
   snapshot into live data. Highest ratio of impression to effort left.
6. **Commit one scan artifact.** `out/` is gitignored, so "every figure ships
   with its transaction hashes" is true of the tool and false of everything the
   project has published. One committed JSON makes the headline finding
   checkable by a stranger.
7. **Record the stellar.expert cross-check.** It is asserted four times with no
   artifact. A short `docs/verification.md` — accounts, dates, what agreed and
   what did not — converts a self-report into evidence.
8. **The GSAP licence.** `packages/web/vendor/gsap.min.js` is "All rights
   reserved" under the GreenSock Standard License, while the site FAQ says
   "MIT, entirely." One grep finds it. Either note the exception or drop the
   dependency.
9. **The Anchor pricing tier** lists "Verified data feed", "Dispute portal
   access" and "Pre-publication alerts" with no *planned* marker, in the only
   tier without one. `docs/gaps.md` already concedes the dispute portal does
   not exist.
10. **"Sign in" in the nav.** The honesty lives one click deep inside the modal
    ("There are no accounts to sign in to"). Nav copy is what a reviewer skims.
    `docs/gaps.md` prescribed "Join the waitlist" and it was never applied.
11. **The contact form** promises "a real reply" and "anchor disputes get
    priority" before disclosing, only after submission, that it has no backend
    — and no email address appears anywhere on the site.

**Worth doing**

12. **CI does not run `cargo test`.** The contract is the Stellar-specific
    differentiator and a Rust change can land breaking it. Add the 16 contract
    tests and a `wasm32v1-none` build.
13. **Move to an organisation.**
14. **`docs/api.md`.** `docs/gaps.md` claims the API "is documented"; it is not,
    outside the source and a route list in a 404 handler.

---

## The honest summary

The intellectual case is stronger than almost anything in the cohort: a real
finding, a data source that cannot be faked, and a dependency on Stellar
primitives that would not survive a port. The execution gap is that **nothing
is running and nobody has used it**.

Four of the six defects fixed today were of one kind — the repo claiming
something that was not true. That is the failure mode this project exists to
detect in anchors, which makes it both the most embarrassing kind of bug to
have and the most important one to keep hunting. The gap list is the mechanism.
Keep it honest and it keeps earning the standing to publish other people's
numbers.
