# Contributing to Landfall

Landfall measures whether Stellar anchors actually settle. Everything it
publishes comes off the public ledger, so contributions are judged on one
thing above all: **does the number remain provable?**

New here? Start with an issue labelled **`good first issue`**. Every issue has
a scope and an acceptance criterion, so you can begin without asking a question
first.

---

## 1. Get it running

### Option A — the whole stack (Docker)

Everything, with one command. No account anywhere, no mainnet, no credentials.

```bash
git clone https://github.com/ibochivincent-lang/landfall.git
cd landfall
cp .env.example .env
docker compose up
```

That starts:

| Service | URL | What it is |
|---|---|---|
| Stellar Quickstart | http://localhost:8000 | core + Horizon + Soroban RPC + friendbot, private network |
| Postgres | `postgres://landfall:landfall@localhost:5432/landfall` | schema applied on first boot |
| Indexer | — | scans on a loop, writes to Postgres |
| API | http://localhost:8787 | read-only HTTP over the dataset |
| Site | http://localhost:8080 | the public page |

First boot takes a few minutes — Quickstart has to build a genesis ledger.
Watch for it becoming healthy:

```bash
docker compose logs -f stellar
curl http://localhost:8787/health     # {"ok": true} once the API is up
```

Tear down with `docker compose down`, or `docker compose down -v` to wipe the
database as well.

### Option B — just the bit you're changing

**You do not need Docker to fix a metric.** The indexer runs standalone with no
database at all:

```bash
npm install
npm test                # 35 tests, fully offline
npm run scan            # scan mainnet anchors and print the report
```

For the contract:

```bash
npm run contracts:test  # 16 tests
npm run contracts:build # wasm
```

Requires Rust with the `wasm32-unknown-unknown` target:

```bash
rustup target add wasm32-unknown-unknown
```

### Running against the local network

```bash
npm run scan -- --horizon http://localhost:8000 --persist
```

`--persist` needs `DATABASE_URL` set. Without it the scan still runs and writes
JSON to `out/`.

---

## 2. Pick something up

1. Find an issue. `good first issue` is scoped and unblocked; `help wanted` is
   larger and looking for an owner.
2. **Comment to ask for it, and wait to be assigned.** An unassigned issue is
   not yours. If you are working through a bounty program, this rule is
   enforced — work on an unassigned issue may not be credited.
3. Ask in the issue if anything is unclear. A question is cheaper than a
   rejected PR.

---

## 3. The six invariants

These are project rules, not style preferences. A PR that breaks one will be
sent back regardless of how well it works. Full detail in
[DEVELOPMENT.md](DEVELOPMENT.md).

1. **No number we cannot prove.** Every published figure traces to indexed
   ledger records. Add a stat, add its derivation to
   [docs/methodology.md](docs/methodology.md) in the same PR.
2. **Failures stay visible.** A domain that will not resolve prints `FAIL`.
   Never turn an error into a silent skip — a missing anchor is a finding.
3. **Thin data is suppressed, not ranked.** A rate over three payments is
   noise. Respect `--min-inbound`.
4. **Heuristics are labelled as heuristics** everywhere they surface.
5. **Money is BigInt stroops.** Never `parseFloat` an amount. Use
   `toStroops` / `fromStroops` from `packages/indexer/src/metrics.ts`. In SQL,
   amounts are `NUMERIC(30,7)`, never float.
6. **Degradation is stale, not broken.** Interrupted work resumes from a
   cursor. Never leave the system quietly wrong.

The two that catch people most often are 5 and 2.

`packages/indexer/src/metrics.ts` and `report.ts` are pure — no I/O. Keep them
that way; it is why the suite runs offline.

---

## 4. Open a pull request

```bash
git checkout -b feat/short-description
# ... work ...
npm test && npm run typecheck
git commit -m "Short summary in the imperative"
git push origin feat/short-description
```

Branch naming: `feat/`, `fix/`, `docs/`, `chore/`, `test/`.

A PR is ready when:

- [ ] It links its issue (`Closes #123`)
- [ ] `npm test` and `npm run typecheck` pass — CI runs both on Node 20 and 22
- [ ] Contract changes: `npm run contracts:test` passes
- [ ] Behaviour changes carry a test. New metrics need a null/empty-input case
- [ ] Published numbers changed? `docs/methodology.md` updated in the same PR
- [ ] The diff is focused. Unrelated refactors make review slow

Commit messages: imperative mood, explain *why* in the body when the reason
isn't obvious from the diff. Look at `git log` for the house style.

---

## 5. What not to build

Some things are deliberately out of scope. Proposing them is fine; opening a
surprise PR is a waste of your time.

- **A consumer rate-comparison dashboard.** Distribution is the SDK. People
  sending money home do not comparison-shop on websites.
- **Transaction execution.** Landfall reports; it does not move funds. A
  measurement service that also handles your money has a conflict of interest
  attached to every score it publishes.
- **Any score component an anchor could fake in ten seconds.** If a TOML edit
  changes it, it does not belong in the score.

---

## 6. Reporting a data error

If a published figure looks wrong, open an issue with the account, the scan
timestamp, and the transaction hashes from the JSON output. Every number is
traceable to ledger records, so disagreements are settled by checking the
ledger rather than by argument. That is the point of the design.

We have already published two defects found in our own tool during
verification, including what the numbers were before and after. A project that
scores other people's reliability has no standing to hide its own.

---

## 7. Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies. One clause specific to this
project: **discussion of a named anchor stays factual.** If the ledger shows 40
days of dormancy, say that. Do not extrapolate to fraud. Our credibility
depends on the distinction between what we measured and what we suspect.
