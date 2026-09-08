# Landfall — status and checklist

Last updated 8 September 2026.

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
- [x] 431 tests passing offline, including a mock Horizon server
- [x] Postgres schema — 27 tables across 13 migrations, verified on real Postgres 16
- [x] `--persist`, cursors and scan bookkeeping wired end to end
- [x] Read-only HTTP API, eight endpoints, caveats in every payload
- [x] Transactions dashboard at `/dashboard`, keyset-paginated
- [x] Soroban oracle, 25 tests, **deployed to testnet**
- [x] Deployment path: Supabase, production compose, Vercel API proxy
- [x] 431 tests passing offline, plus integration against real Postgres

**The evidence**

- [x] Real scans run against mainnet — 13 accounts, 5 domains, ~4,000 payments
- [x] Findings cross-checked against stellar.expert
- [x] Two bugs found and fixed, both with named regression tests
  - liveness was read inside the `--since` window, hiding the most dormant account
  - dust inflated activity counts and created phantom refund pairs
- [x] Headline verified: **6 of 13 accounts dark over 30 days**

**The writing**

- [x] README, methodology, roadmap, CONTRIBUTING, DEVELOPMENT.md
- [x] 20 backlog items scoped and point-tagged
- [x] `docs/deployment.md` — Supabase, hosting, the RLS trap, and what is
      still not automated
- [x] `docs/gaps.md` kept as a struck-through record rather than edited clean
- [x] `scripts/setup-issues.ps1` written and dry-run tested

**Publishing**

- [x] Repo pushed public to `ibochivincent-lang/landfall`

---

## Deployment — live, with two things still off

The stack is deployed. What follows is what is actually running, and the two
switches deliberately left off.

- [x] Supabase project created; migrations applied — and CI now re-applies
      them on every push to `main`, so a new migration reaches production
      without a manual step
- [x] Mainnet scan running with `--persist`
- [x] API deployed on Vercel, serving REST + GraphQL
- [x] `/dashboard` reading the live API rather than the bundled snapshot
- [x] Indexer scheduled — hourly GitHub Actions cron, `$0/month`
- [x] Oracle **deployed to testnet** — `CA2IYHFKTKSJWR5IICY6HFD55BJEGE7OMKISWMLMPFSHLESZYO3VICAG`
      (13 August 2026). Four bugs surfaced on the way: the wrong wasm target,
      a missing host C linker, PowerShell treating stderr as failure, and
      three CLI flags that do not exist — all fixed in the scripts
- [x] `scripts/publish-oracle.mjs` wired into the hourly run, and verified
      end to end in a dry run (6 September 2026)
- [ ] **Oracle publishing is off in production** — `ORACLE_ADMIN_SECRET` is
      unset, so the step no-ops by design. Before switching it on: install a
      distinct publisher key (`set_publisher`) so CI never holds the admin
      key, and make the admin account multisig. See `docs/TRUST.md`
- [ ] **Mainnet oracle** — needs funded keys and a custody decision, plus an
      external audit applied for
- [ ] **Database backup beyond Supabase's default retention.** The
      observation record is committed to the repo
      (`data/scan-history.ndjson`, appended hourly), which covers the
      measurements — but the application tables (portal users, API keys,
      fraud reports and their disputes) have no backup outside Supabase

---

## Tool quality — no deadline, ordered by value

- [ ] **M1: memo-based leg correlation.** Turns the return metric from a
      heuristic into a measurement.
- [ ] Investigate why `vibrantapp.com` served a TOML with no parseable
      accounts. Probably a parser gap, not an empty declaration.
- [ ] Expand `packages/indexer/data/anchors.json` beyond the current 8 candidate domains.
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
