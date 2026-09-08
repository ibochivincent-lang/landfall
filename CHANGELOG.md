# Changelog

All notable changes to this project are recorded here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, following
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Pre-1.0, minor versions may contain breaking changes.** Pin exact versions
of [`@landfall/sdk`](https://www.npmjs.com/package/@landfall/sdk).

Two conventions this file is held to, because a changelog nobody trusts is
worse than none:

- **Every behaviour change updates `Unreleased` in the same commit.** A
  changelog written from `git log` at release time records what was easy to
  reconstruct, not what mattered.
- **Corrections are listed, not quietly dropped.** Where a published claim
  turned out to be wrong, it appears under **Fixed** naming what was wrong —
  the same rule [`docs/gaps.md`](docs/gaps.md) follows.

Only the latest `main` is supported. Fixes are not backported; see
[SECURITY.md](SECURITY.md).

---

## [Unreleased]

### Added

- **`refund.spike` has a producer.** Subscribable since the developer portal
  shipped with nothing emitting it; migration 010 kept the value rather than
  dropping a subscription someone had chosen, and it is now honoured instead
  of retired. Gated on at least 25 inbound payments before a rate is
  considered at all — derived from the record, where an ungated rule fires
  twice on an account whose "16.7% return rate" is one return out of six
  payments. Payload carries `inboundCount` so the sample travels with the
  percentage.
- **[`docs/TAKEDOWN.md`](docs/TAKEDOWN.md)** — what happens when someone
  demands a finding be removed. Separates a correction (always welcome,
  treated as a bug) from a takedown (declined, with reasons), commits to
  complying with a court order from a jurisdiction that has one, and to
  recording *that* a compelled removal happened even where the content cannot
  be restated. `JURISDICTIONAL.md` had listed this as the most likely legal
  event with no rehearsed answer.

### Fixed

- **A domain dropping out of a scan was invisible in `/api/v1/anchors`.** On
  8 September eleven consecutive scans reported 27 domains and 108 accounts;
  the twelfth reported 26 and 93, because `zeam.money` and its fifteen
  accounts were not reached — while its TOML still resolved and it was still
  tracked. Nothing in the response said so, making a tracked anchor that
  vanishes indistinguishable from one that was never tracked. The response now
  carries a `coverage` block: tracked versus reached, `complete`, and a
  `missing` list naming each dropped domain with its resolve error, or an
  explicit `null` where the cause is genuinely unknown rather than a guess.
  Adding a field, so not breaking.
- `VERSIONING.md` described `refund.spike` in the present tense as an
  obsolete-but-retained value, and still said no tag had been cut.

---

## [0.1.0] — 2026-09-08

The first tagged release. Everything below was already on `main`; this tag
gives it a fixed point a consumer can pin to and diff from.

Grouped by capability rather than by change, because there is no previous tag
to diff against — the next release will be a normal changelog section.

### ⚠️ Breaking

- **The oracle's `MAX_BATCH` is 25, not 100.** A batch of 100 would have
  failed on a real network: the binding limit is the 16 KiB cap on contract
  event size, not CPU. Measured ceilings are 70 for an all-live batch (one
  `ScoreSet` per account) and **35 for an all-dark batch**, which emits a
  `WentDark` alongside each `ScoreSet`. A full batch therefore exceeded the
  limit in every mix, and worst in the case that matters most — the scan
  where an anchor's whole fleet goes dark at once.

  25 is the worst case with roughly 30% headroom. The headroom is deliberate:
  the contract has **no upgrade path**, so a future protocol version raising
  per-event costs cannot be answered by patching a deployed contract.

  Callers passing more than 25 accounts to `set_scores` now receive error
  `5` (`TooManyAccounts`) instead of a transaction that would have failed
  on-chain. `scripts/publish-oracle.mjs` is unaffected — it calls
  `publish(digest)`, never `set_scores`.

### Added

- **Contract resource measurement.** `src/bench.rs` reports CPU and memory
  for every entry point and runs in the normal suite; `src/bench_probe.rs`
  re-derives the batch ceilings against the host and is `#[ignore]`, run on
  demand. This is what found the `MAX_BATCH` defect above.
- **`storage_version()`** — a compatibility declaration, not a migration
  marker. The contract is immutable by design, so a new schema means a new
  deployment at a new address rather than changed semantics at the old one.
- **Webhook dead-letter replay** — migration `014` stores the delivery
  payload so a failed delivery can be replayed at all;
  `scripts/redeliver-webhooks.mjs` retries hourly for 48 hours, resending the
  original event verbatim rather than rebuilding it from state that has since
  moved on.
- **Documentation** — `API_REFERENCE`, `WEBHOOKS`, `ORACLE_SPEC`,
  `SEP_COVERAGE`, `CANONICAL_JSON`, `NON_CUSTODY`, `JURISDICTIONAL`,
  `GOVERNANCE`, `VERSIONING`, `TERMS`, `WHY_NOT`, `FAQ`, `BENCHMARKS`,
  `CONTRIBUTOR_LADDER`, `KEY_ROTATION`.

### Fixed

- **The wrong oracle contract ID** was published in three docs. The current
  testnet contract is `CDPCH3UO…OX6B5LW`, verified responding at epoch 2; the
  13 August deploy no longer responds, its state having expired past the ~30
  day TTL.
- **The handler's own route list omitted three live routes** —
  `GET`/`POST /api/v1/auth` and `POST /api/v1/graphql`.
- **`GET /api/v1/auth` returns 503 in production**, because
  `SEP10_SERVER_SECRET` is unset. Implemented and tested, switched off rather
  than missing — now stated in the API reference instead of implied working.
- **Webhook scripts hardcoded TLS**, so neither could reach a local Postgres;
  the delivery path could only ever be exercised against a hosted database.

---

## Before this changelog

The repository's history was rewritten on 5 September 2026 to consolidate
authorship, so `main` begins there. What follows is grouped by capability
rather than by release.

### Shipped

- **Ledger indexing** — SEP-1 discovery, resumable Horizon cursors, BigInt
  stroop arithmetic, hourly scans via GitHub Actions.
- **Trust Check** — ledger-only counterparty signals for any Stellar address:
  observed history, counterparty concentration, forwarding patterns, a
  transparent 0–100 score, and a confidence rating that overrides the score
  when history is too thin.
- **Fraud Reports** — every report must cite a transaction verified to exist
  *and* involve the subject before it is stored. Report volume is never
  scored.
- **Disputes** — the reported party responds by proving control of the
  address with an Ed25519 signature, never a password. A signed attestation
  of that response is available, and it deliberately never covers the
  accusation.
- **AI Investigator** — deterministic cited facts computed with no model at
  all, plus an optional narrative over exactly those facts, labelled with the
  model that wrote it and `null` when no key is configured.
- **Intent and Route Engine** — routes ranked with evidence ahead of price;
  plans where every step names its actor, and `landfall` never appears on one
  that moves value.
- **Cross-chain evidence** — Stellar `PROVEN`, EVM/CCTP `ATTESTED`, Tron and
  Solana `DERIVED`, compared lexicographically and never blended.
- **Soroban oracle** — dataset digest and per-account liveness, deployed to
  testnet.
- **`@landfall/sdk` 0.1.0** — published to npm 7 September 2026, verified
  against the registry copy rather than the local build.
- **MCP server** — 11 read-only tools over stdio.
- **x402 payee check** — Trust Check for every Stellar payee named in a real
  402 response, before an agent signs.
- **SEP-10 web authentication** — anchor operators prove control of an
  account instead of registering a password.

### Security

- **Oracle write authority split from admin authority.** `publish`,
  `set_score` and `set_scores` now gate on a **publisher** address, while
  `set_admin` and `set_publisher` gate on the **admin**. The hourly key held
  by CI can write scores but cannot take the contract. This could not be
  fixed with Stellar account multisig alone: Soroban's built-in account
  contract always checks the *medium* threshold, so one address cannot have a
  lower bar for writing a score than for handing over the contract — making
  the admin 2-of-N would have stopped the hourly publish instead.
- **Contract tests raised from 16 to 25**, nine of them covering that split.
  They use `mock_auths` rather than `mock_all_auths` on purpose: under
  `mock_all_auths` every `require_auth` passes, so a privilege-escalation
  test would pass whether or not the split worked.
- **CI now runs `cargo test`.** It never had, which meant those nine
  regression tests would not have run on any push.

### Fixed

- **Three POST routes were unreachable in production** — `v1/intent`,
  `v1/fraud-reports` and `v1/fiat-confirmations` all returned 405 from the
  day they shipped, stranded below a blanket GET-only guard. Now
  allow-listed, with `api/_lib/routes.test.mjs` reconstructing each route's
  runtime path so the next one cannot be forgotten the same way.
- **Documented routes that never existed** — `GET /api/v1/summary` and
  `GET /api/v1/dark` appeared in the architecture doc, and the deployment
  runbook used `/v1/summary` for its health check. Both return 404.
- **Scan history was orphaned by the history rewrite.** 26 days of hourly
  observations survived only on two local-only branches; they are now
  committed as [`data/scan-history.ndjson`](data/scan-history.ndjson) and
  appended hourly. `hoursSinceActivity` and `topCounterpartyShare` are
  point-in-time readings Horizon cannot be asked for retroactively.
- **Test and table counts across the docs** had drifted to 35, 37, 42 and 342
  in different files, against a real figure of 431 JS and 25 Rust; table
  counts said 12 and 15+ against a real 27.
- **Docs credited work to "a teammate"** on a single-author repository.

### Measured, and deliberately not built

- **Dark-anchor early warning.** Against the committed observation record,
  exactly one account went dark in 26 days (`slow` → `dark`, n=1) against 17
  `live` → `slow` degradations. The roadmap requires a published
  false-positive rate, and one positive example cannot produce one that means
  anything. Revisited on a count of events, not a date.
- **Payment execution.** Holding a key or a session with one is custody, and
  a different risk category from indexing a public ledger. See
  [`docs/architecture/VERIFIED_ROUTES.md`](docs/architecture/VERIFIED_ROUTES.md).

[Unreleased]: https://github.com/ibochivincent-lang/landfall/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ibochivincent-lang/landfall/releases/tag/v0.1.0
