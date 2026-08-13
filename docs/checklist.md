# Landfall — status and checklist

Last updated 13 August 2026.

Repo: https://github.com/ibochivincent-lang/landfall (public)

---

## Done

**The tool**

- [x] Concept designed — ledger observation rather than endpoint probing
- [x] SEP-1 discovery: home domain → declared on-chain accounts
- [x] Horizon indexer with pagination, backoff and resume cursors
- [x] BigInt stroop arithmetic — no float drift on aggregate volume
- [x] Refund detection heuristic with documented limits
- [x] Liveness classification (live / slow / dark / no-activity)
- [x] Dust filtering
- [x] 35 tests passing offline, including a mock Horizon server
- [x] Postgres schema — 12 tables, verified on real Postgres 16
- [x] `--persist`, cursors and scan bookkeeping wired end to end
- [x] Read-only HTTP API, eight endpoints, caveats in every payload
- [x] Transactions dashboard at `/dashboard`, keyset-paginated
- [x] Soroban oracle written, 16 tests — **never deployed to any network**
- [x] Deployment path: Supabase, production compose, Vercel API proxy
- [x] 40 tests passing (35 offline + 5 integration against real Postgres)

**The evidence**

- [x] Real scans run against mainnet — 13 accounts, 5 domains, ~4,000 payments
- [x] Findings cross-checked against stellar.expert
- [x] Two bugs found and fixed, both with named regression tests
  - liveness was read inside the `--since` window, hiding the most dormant account
  - dust inflated activity counts and created phantom refund pairs
- [x] Headline verified: **6 of 13 accounts dark over 30 days**

**The writing**

- [x] README, methodology, roadmap, CONTRIBUTING, DEVELOPMENT.md
- [x] 21 backlog items scoped and point-tagged
- [x] SCF submission pack drafted — **not currently in the repository**
- [x] `docs/deployment.md` — Supabase, hosting, the RLS trap, and what is
      still not automated
- [x] `docs/gaps.md` kept as a struck-through record rather than edited clean
- [x] `scripts/setup-issues.ps1` written and dry-run tested

**Publishing**

- [x] Repo pushed public to `ibochivincent-lang/landfall`
- [x] Drips GitHub App installed on the account

---

## SCF — the only hard deadline

**Interest form closes 16 August 2026.**

- [ ] **Submit the interest form**
      - what you're building: the paragraph block
      - track: Integration
      - referral: leave blank
      - form lives on https://communityfund.stellar.org/awards under SCF #45

Then only if invited to the full Build Award submission:

- [ ] One line of real background per team member, with links
- [ ] State part-time or full-time so the budget arithmetic holds
- [ ] Re-run the scan on submission day and update the figures
- [ ] Confirm 2028 appears nowhere as a delivery date, only as roadmap horizon
- [ ] Read it once as a reviewer who has never heard of the project

---

## Drips Wave — no deadline

- [ ] Read the 21 backlog items and cut or reword anything you don't want
      contributors touching. Easier to edit a markdown file than to close
      issues someone has already claimed.
- [ ] Run `.\scripts\setup-issues.ps1 -WhatIf`, then without `-WhatIf`
- [ ] Commit and push the script
- [ ] Refresh in Drips → sync `landfall`
- [ ] Apply the repo to the Stellar Wave
- [ ] Wait for organiser approval
- [ ] During sprint week: assign and review fast. Maintainers who go quiet
      mid-wave are the main way this goes wrong.

---

## Deployment — nothing is running anywhere yet

The stack is deployable and not deployed. Until one of these is ticked, every
"live" claim on the site is a claim about a local machine.

- [ ] Create the Supabase project and run `.\scripts\migrate.ps1` against the
      **direct** connection (5432, not the 6543 pooler)
- [ ] Run the first mainnet scan with `--persist` so there is something to serve
- [ ] Deploy the API somewhere with a persistent process; set `CORS_ORIGIN` to
      the real site origin, not `*`
- [ ] Set `LANDFALL_API_URL` in the Vercel project and redeploy, so
      `/dashboard` stops showing its "no API connected" panel
- [ ] Schedule the indexer — a real cron job on the host, not the compose loop
- [ ] `./scripts/deploy-contract.sh testnet`, then put the contract id in the
      README. Sixteen passing tests is not the same claim as a deployed contract
- [ ] Take one `pg_dump` and put it somewhere that is not Supabase

---

## Tool quality — no deadline, ordered by value

- [ ] **M1: memo-based leg correlation.** Turns the return metric from a
      heuristic into a measurement. Also Tranche 1 of the grant, so a
      contributor picking this up is grant milestone work getting done.
- [ ] Investigate why `vibrantapp.com` served a TOML with no parseable
      accounts. Probably a parser gap, not an empty declaration.
- [ ] Expand `data/anchors.json` beyond the current 8 candidate domains.
      More coverage makes the dark-account census stronger.
- [ ] Multi-region indexing, to remove the single-vantage assumption
- [ ] Talk to one wallet about embedding the SDK. Layer 2 needs attestors,
      and one conversation in progress is worth more in an application than
      three more features.

---

## Deliberately not doing

- Username/payment layer — good idea, separate project. Adding it here would
  break the single-claim coherence that makes the submission strong, and it
  contradicts the stated boundary that Landfall reports but does not move funds.
- Consumer rate-comparison dashboard — distribution is the SDK.
- Any score component an anchor could fake in ten seconds.
