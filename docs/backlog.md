# Contributor backlog

Scoped, point-tagged issues ready to be opened as GitHub issues. Complexity
tiers match Drips Wave conventions: **Trivial 100 / Medium 150 / High 200**.

Each entry is written so a contributor can start without asking a question
first. That is the bar — if an issue needs a clarifying conversation, it is
not ready to be opened.

---

## Trivial (100)

**T1 — Add `--format json|table` to the CLI**
`src/cli.ts` currently always prints a table and writes JSON to disk. Add a
flag to print JSON to stdout instead, for piping. Acceptance: `--format json`
emits valid JSON on stdout and nothing else; table remains the default.

**T2 — Support `http://` horizon URLs for local development**
`--horizon` assumes https in documentation. Verify local Horizon and
quickstart images work, and document the flag in README. Acceptance: a run
against `http://localhost:8000` succeeds.

**T3 — Print a progress counter during long scans**
`fetchPayments` accepts an `onProgress` callback that `cli.ts` never passes.
Wire it up to a single-line updating counter on stderr. Acceptance: scanning
a large account shows a live record count.

**T4 — Add `--min-volume` suppression alongside `--min-inbound`**
Some accounts have many tiny payments. Add a volume floor per asset.
Acceptance: accounts below the floor are excluded from the headline, still
listed in the table.

**T5 — Emit a CSV alongside the JSON output**
One row per account with the headline columns. Acceptance: `out/scan-*.csv`
written on every scan, parses in a spreadsheet.

---

## Medium (150)

**M1 — Read SEP-24 memos to correlate transaction legs**
The highest-value item in the repo. `docs/methodology.md` §5 explains that
refund detection over-counts and under-counts because it ignores memos. Read
the memo from each transaction and use it to correlate inbound and outbound
legs directly. Acceptance: memo-matched pairs are marked as `confidence:
"memo"` versus `"heuristic"` in the JSON, and the report distinguishes them.

**M2 — Persist a resume cursor between runs**
`fetchPayments` returns `newestCursor` and nothing stores it. Write a small
state file keyed by account so subsequent runs only fetch new records.
Acceptance: a second run on an unchanged account fetches zero pages.

**M3 — Detect partial refunds**
Current matching requires amounts to agree within 2%. Extend to detect an
outbound that is a meaningful fraction (say 20–98%) of a prior inbound, and
report it as `partial`. Acceptance: partial returns appear in a separate
count, not folded into the full refund rate.

**M4 — Confidence intervals on refund rate**
A rate of 4% over 30 payments and 4% over 30,000 are not equivalent claims.
Compute a Wilson score interval and render it. Acceptance: the table shows
`3.90% ±1.2` and the headline states the interval.

**M5 — Multi-account anchors**
An anchor may operate several accounts. Roll metrics up to the domain level
rather than reporting each account separately, while keeping per-account
detail in the JSON. Acceptance: the table has one row per domain.

**M6 — Handle account deletion and merges**
`account_merge` operations are currently discarded. An anchor account being
merged away is a strong signal. Acceptance: merges are detected and surfaced
in the report.

---

## High (200)

**H1 — Signed settlement receipt ingest (Layer 2)**
Implement the attestation schema in the project brief: accept a receipt
signed by the Stellar key that made the on-chain payment, verify the
signature against the referenced transaction, and store it. Reject any
receipt whose `stellar_tx` does not exist or was not signed by the claimed
key. Acceptance: a forged receipt is rejected; a valid one is accepted and
linked to its ledger record.

**H2 — Slippage metric from quote versus landed amount**
Once H1 lands, compute the gap between the SEP-38 quoted amount and the
attested landed amount. This is the metric the whole ecosystem is missing.
Acceptance: per-anchor median slippage, with sample counts and suppression
below a data floor.

**H3 — `@landfall/sdk` with `pickAnchor()`**
Publishable package exposing `pickAnchor({from, to, amount})` returning a
ranked list with confidence. This is the distribution strategy — wallets
embed it, users never see the brand. Acceptance: package builds, has types,
and works against the public API.

**H4 — MCP server exposing anchor quality to agents**
Expose the dataset over MCP so payment agents can query anchor reliability
natively. Acceptance: an MCP client can list tools and retrieve rankings.

**H5 — Soroban oracle publishing signed score digests**
On-chain contract publishing periodic signed digests so other contracts can
route programmatically. Acceptance: contract deployed to testnet, digest
verifiable against the published dataset.

---

## Explicitly out of scope

- Consumer-facing rate comparison UI. Distribution is the SDK, not a
  dashboard people visit. A dashboard exists only as marketing for the data.
- Executing transactions. Landfall reports; it does not route funds.
- Scoring anchors on anything self-reported. If the anchor could fake it in
  ten seconds, it does not belong in the score.
