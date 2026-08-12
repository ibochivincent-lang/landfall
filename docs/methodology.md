# Methodology

Everything Landfall publishes is derived from public Stellar ledger records.
This document states exactly how, including where the method is weak. If a
number cannot be reproduced from these rules, it is a bug.

---

## 1. Account discovery

Landfall does not ship a trusted list of anchor accounts. It resolves them:

1. Read candidate home domains from `data/anchors.json` (or `--domains`)
2. Fetch `https://<domain>/.well-known/stellar.toml` (SEP-1)
3. Extract every account in the `ACCOUNTS` array, plus the `issuer` of each
   `[[CURRENCIES]]` block
4. Deduplicate; label each as `declared` or `issuer`

**Known weakness — attribution.** An account declared in a TOML is claimed by
that domain, not proven to belong to it. Landfall reports what the domain
declared. It does not attempt to detect a domain claiming someone else's
account. Misattribution is the main correctness risk in the whole system.

A domain that fails to resolve is reported as `FAIL`, never dropped silently.
An anchor whose TOML is unreachable is itself a finding.

---

## 2. Record collection

For each account, page `GET /accounts/{id}/payments` newest-first at 200 per
page, following `_links.next.href`, until either `--max-records` or the
`--since` boundary is reached.

Operation types handled:

| Type | Treatment |
|---|---|
| `payment` | `from` → `to`, `amount`, asset |
| `path_payment_strict_receive` / `_send` | delivered `amount` |
| `create_account` | `funder` → `account`, `starting_balance`, native |
| anything else | discarded |

HTTP 429 triggers exponential backoff, up to four retries.

The paging token of the newest record is retained as a resume cursor. This is
why the failure mode is *stale* rather than *broken*: an interrupted run
resumes forward from the last cursor and loses nothing.

---

## 3. Arithmetic

Stellar amounts carry 7 decimal places. All sums are computed in **integer
stroops using BigInt**, never floating point. Floats appear only in ratios,
where drift is immaterial. This is tested — `0.1 + 0.2` sums to exactly `0.3`.

---

## 4. Direction

Relative to the anchor account `A`:

- **inbound** — `to === A` and `from !== A`
- **outbound** — `from === A` and `to !== A`

Self-payments are counted in `sampled` but excluded from both directions.

---

## 5. Refund detection — the heuristic

Under SEP-24 a withdrawal begins with the user sending the asset on-chain to
the anchor. If the anchor cannot complete the off-chain fiat leg, the honest
behaviour is to send the asset back. **That return is visible on the ledger.**

An outbound payment is matched to a prior inbound payment when **all** hold:

1. Same counterparty
2. Same asset
3. Outbound occurs strictly after the inbound
4. Gap ≤ `refundWindowHours` (default 30 days)
5. `|out − in| / in ≤ refundTolerance` (default 2%, absorbing fees)

Matching is **greedy nearest-in-time**, and each inbound may be consumed at
most once.

### Where this is wrong

- **Over-counts.** A user who deposits and later withdraws a similar amount to
  the same account looks identical to a refund on-chain. High-frequency
  counterparties inflate the rate.
- **Under-counts.** Partial refunds fall outside the 2% tolerance and are
  missed entirely. So does a refund sent from a different anchor account.
- **No memo matching.** SEP-24 uses memos to correlate legs. Landfall does not
  yet read them. Doing so would sharply reduce both error directions and is
  the single highest-value improvement available.

The refund rate is therefore an **indicator, not a measurement**. It is
published with both transaction hashes for every pair so that any specific
claim can be checked against the ledger by anyone.

---

## 6. Suppression

An account is excluded from the headline unless it has at least
`--min-inbound` inbound payments in the sampled window (default 25). A refund
rate over three payments is noise dressed as a statistic. Excluded accounts
still appear in the table and the JSON, marked with their true counts.

---

## 7. What the ledger cannot tell you

The fiat leg is invisible on-chain. Landfall **cannot** currently determine:

- Whether naira actually reached a bank account
- The realised rate a user received
- Slippage between the SEP-38 quoted amount and the landed amount

This is the gap Layer 2 (signed settlement receipts) is designed to close.
Until it ships, no Landfall output should be read as a claim about fiat
delivery. The project says so wherever a number is displayed.
