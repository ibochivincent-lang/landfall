# Oracle specification

The on-chain half of Landfall: a Soroban contract publishing a digest of each
scan plus a liveness state per account, so a contract can route on the same
data a wallet reads from the API.

| | |
|---|---|
| Source | [`packages/contracts/landfall-oracle`](../packages/contracts/landfall-oracle) |
| SDK | soroban-sdk 27 |
| Testnet | [`CDPCH3UO4ORG6OMWH5B4RCPIHN7TS5NL5QATWRW6DHEN7UYIPOX6B5LW`](https://stellar.expert/explorer/testnet/contract/CDPCH3UO4ORG6OMWH5B4RCPIHN7TS5NL5QATWRW6DHEN7UYIPOX6B5LW) — verified live, epoch 2 |
| Mainnet | **Not deployed.** See [TRUST.md](TRUST.md) for what must happen first |
| Schema version | `1` |
| Superseded | `CA2IYHF…VICAG`, the 13 August deploy. **No longer responds** — its state expired past TTL |
| Upgradeable | **No, deliberately** |

---

## What it stores, and what it does not

It does **not** store the dataset. It stores a **digest** of it, plus a small
liveness state per account. The full record stays off-chain where it is cheap,
and anyone can re-derive the digest from the published data and check the two
agree.

That is the whole design: an oracle that asks you to trust it has missed the
point of being an oracle. The on-chain value is not the data — it is a
commitment you can check the data against.

It also moves no value, holds no asset, and has no transfer function.

---

## Types

```rust
enum Liveness { Live = 0, Slow = 1, Dark = 2, NoActivity = 3 }

struct Score {
    state: Liveness,
    last_activity: u64,   // ledger timestamp of last settlement; 0 if none
    sampled: u32,         // records behind the classification
    epoch: u64,           // epoch this score was written in
    updated_at: u64,
}
```

**`NoActivity` is not `Dark`.** An issuer account moves value through
trustlines rather than payments, so an empty payment history is normal
structure, not dormancy. Collapsing the two manufactures a finding — treat
them separately in any consumer.

**`sampled` is a caveat, not decoration.** A `Dark` classification over 3
records is not the same claim as one over 3,000. Read it before acting on
`state`.

---

## Reading the oracle

All read entry points are free of authorisation.

| Function | Returns |
|---|---|
| `get_digest() -> Option<BytesN<32>>` | SHA-256 of the most recently published dataset |
| `get_epoch() -> u64` | Monotonic publication counter |
| `get_score(account) -> Option<Score>` | One account's score, or `None` |
| `is_dark(account) -> bool` | Convenience over `get_score` |
| `tracked() -> Vec<Address>` | Every account ever scored |
| `admin() -> Address` | Current admin |
| `publisher() -> Address` | Current publisher; falls back to admin if unset |
| `storage_version() -> u32` | Schema version. `1` |

```bash
stellar contract invoke --id $ORACLE_CONTRACT_ID --network testnet -- get_epoch
stellar contract invoke --id $ORACLE_CONTRACT_ID --network testnet -- is_dark --account G…
```

### Two traps for consumers

**`is_dark` returning `false` is not reassurance.** An account with no score
at all returns `false` — absence of a record is not evidence of liveness.
Check `get_score(account).is_some()` before reading `false` as good news.

**`get_epoch` is how you detect a missed update.** It increments once per
publication. If it has not moved since you last looked, the dataset has not
been republished, and whatever you cached is still current — or the publisher
has stopped. Both are worth knowing; the counter cannot tell you which, so
cross-check `staleHours` from the API.

---

## Verifying the digest

The point of publishing a digest rather than a score is that you can check it.

1. Fetch the published dataset from the API.
2. Canonicalise and SHA-256 it — [CANONICAL_JSON.md](CANONICAL_JSON.md).
3. Compare against `get_digest()`.

If they disagree, either the off-chain record or the on-chain commitment has
been altered, and **you should trust neither** until the disagreement is
explained. That is the failure mode this contract exists to make detectable.

---

## Writing to the oracle

Two roles, and the split is the security model.

| Function | Authorised by | Notes |
|---|---|---|
| `publish(digest) -> u64` | **publisher** | Bumps the epoch, emits `Published` |
| `set_score(account, state, last_activity, sampled)` | **publisher** | Emits `ScoreSet`, plus `WentDark` on a transition into dark |
| `set_scores(accounts, scores)` | **publisher** | Batch, **max 25**. Authorises once at the entry point |
| `set_admin(new_admin)` | **admin** | Emits `AdminChanged` |
| `set_publisher(new_publisher)` | **admin** | Emits `PublisherChanged` |
| `initialise(admin)` | — | One-time. Fails loudly if already initialised |

**The publisher cannot take the contract.** `set_admin` and `set_publisher`
gate on the admin; the hourly CI key is the publisher. A leaked publishing key
writes bad scores — visible in the event stream, recomputable from Horizon,
revocable by rotation — but cannot hand the oracle to anyone.

This split exists because Soroban's built-in account contract always checks a
Stellar account's **medium** threshold, so one address cannot have a lower bar
for "write a score" than for "hand over the contract". Making the admin
multisig without splitting the roles would simply have stopped the hourly
publish. Enforced by `the_publisher_cannot_take_the_contract` and
`a_rotated_out_publisher_can_no_longer_write`, which use `mock_auths` rather
than `mock_all_auths` so the check cannot pass vacuously.

**`require_auth` runs once per invocation, at the entry point.** `set_scores`
does not re-enter `set_score` — doing so called `require_auth` twice in one
frame and the host rejected it with `Error(Auth, ExistingValue)`, which made
the batch endpoint panic on-chain every time it was called. Regression test:
`batching_authorises_once_not_per_account`.

---

## Events

Declared with `#[contractevent]`, so topics and payload shapes are part of the
contract spec and an indexer generates its decoder rather than guessing at
string literals.

| Topic | Payload | When |
|---|---|---|
| `init` | `admin` | Once, at initialisation |
| `publish` | `epoch` (topic), `digest`, `publisher` | Every publication |
| `score` | `account` (topic), `state`, `last_activity`, `sampled`, `epoch` | Every score write |
| `dark` | `account` (topic), `last_activity`, `epoch` | **Only on the transition into** dark |
| `set_admin` | `previous`, `next` | Admin handover |
| `set_publisher` | `previous`, `next` | Publisher rotation |

`dark` fires on the transition, not the steady state — a consumer is woken by
a change, not by an account continuing to be dark.

**No CAP-67 asset events are emitted.** CAP-67 standardises
`transfer`/`mint`/`burn`/`clawback` for asset movement; faking those topics
for a scoring update would corrupt the very event stream this project depends
on. The convention is followed instead — symbol topic first, structured data
after — so a CAP-67-aware indexer consumes these with the same machinery.

**Watch `set_admin` and `set_publisher`.** A takeover is publicly visible in
the event stream, and nothing currently watches for it — see
[TRUST.md](TRUST.md).

---

## Errors

| Code | Meaning |
|---|---|
| `1` | Already initialised |
| `2` | Not initialised |
| `3` | Not authorised |
| `4` | Empty batch, or mismatched batch lengths |
| `5` | Batch exceeds 25 accounts |

A mismatched `accounts`/`scores` pair fails rather than assigning scores to
the wrong accounts — on a reputation oracle, silently mis-assigning is worse
than failing.

---

## Storage lifetime

Instance and persistent entries are extended on write:
threshold ~30 days of ledgers, extended to ~90. An oracle nobody has written
to in three months lets its state expire, which is correct — stale data
disappearing is safer than stale data persisting silently.

---

## No upgrade path

There is no `update_current_contract_wasm` and there is not going to be one.
An admin who can replace the bytecode can redefine what `publish` means — a
strictly larger power than writing a wrong score, undetectable from outside
without diffing Wasm hashes.

`storage_version()` is therefore a **compatibility declaration, not a
migration marker**: a new schema means a new deployment at a new address, and
consumers move deliberately rather than waking up to different semantics at
the same one. The cost — a deployed bug cannot be patched in place — is
accepted and stated in [TRUST.md](TRUST.md).

---

## Building and testing

```bash
npm run contracts:build     # cargo build --target wasm32v1-none --release
npm run contracts:test      # 28 tests
npm run contracts:deploy:testnet
```

The deploy script prints the role-split runbook after every deploy.

---

## Related

- [TRUST.md](TRUST.md) — what you must trust, and why this is the load-bearing part
- [KEY_ROTATION.md](KEY_ROTATION.md) — rotating the publisher, and the admin
- [GOVERNANCE.md](GOVERNANCE.md) — who holds which key
- [CANONICAL_JSON.md](CANONICAL_JSON.md) — how the digest is computed
