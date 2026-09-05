# `anchors.registry.json`

Maintained cross-chain address book, keyed by anchor id (MULTICHAIN.md §5,
step 3). An anchor's Stellar accounts are never listed here — those are
resolved live from the domain's `stellar.toml` (SEP-1), which is
permissionless and always current. This file only exists for the chains
that have no equivalent standard field: an operator's addresses on EVM
chains, Tron, or Solana have to be recorded by whoever independently
verified them.

Loaded and validated by [`packages/registry`](../packages/registry).

## Shape

```jsonc
{
  "version": 1,
  "anchors": {
    "<home-domain>": {
      "chains": {
        "<chain>": { "addresses": ["<address>", "..."] }
      }
    }
  }
}
```

`anchorId` is the anchor's home domain — the same string SEP-1 already uses
as its unique key, so there is no second id to keep in sync.

## `cctp.deployments.json`

Per-chain Circle CCTP wiring the EVM adapter needs before it can scan
anything: the chain's CCTP domain id and its `TokenMessenger` contract
address.

```jsonc
{
  "version": 1,
  "deployments": {
    "<chain>": { "domainId": 6, "tokenMessenger": "0x…", "rpcUrl": "https://…" }
  }
}
```

This ships empty for the same reason the anchor registry does: the contract
addresses have to come from Circle's own published deployment list, and a
wrong `tokenMessenger` here doesn't fail loudly — it just returns no logs
forever, which is indistinguishable from an anchor that never bridged. Fill
each entry from <https://developers.circle.com/cctp> and verify it on that
chain's explorer before committing it. Until a chain has an entry, the
cross-chain scan reports it as `unresolved` with that as the stated reason.

## Adding an entry

Only add an address you have independently confirmed belongs to that
anchor's operator on that chain (e.g. from the operator's own published
docs, a signed message, or an on-chain claim they control) — an unverified
guess here would let a settlement get credited to the wrong entity, which
is the one failure mode `evidence_tier` can't catch, because it happens
before an event is even attributed. When in doubt, leave the anchor out
rather than add a low-confidence address.
