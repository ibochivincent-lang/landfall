# Roadmap

Mapped to the Stellar Community Fund Build Award's three tranches.

## Tranche 1 — MVP

- [x] SEP-1 discovery: home domain → declared on-chain accounts
- [x] Horizon indexer with pagination, backoff, resume cursor
- [x] Core metrics: liveness, inbound/outbound volume, concentration
- [x] Refund detection heuristic with published methodology
- [x] Offline test suite including a mock Horizon
- [ ] Memo-based leg correlation (backlog M1) — removes the largest source of error
- [ ] Public dataset published, one corridor (USDC↔NGN) fully characterised
- [ ] Methodology reviewed by one ecosystem participant

## Tranche 2 — Testnet

- [ ] Signed settlement receipt schema and ingest (backlog H1)
- [ ] Slippage metric: quoted versus landed (backlog H2)
- [ ] Public REST/GraphQL API, free tier
- [ ] `@landfall/sdk` with `pickAnchor()` (backlog H3)
- [ ] Two wallet integrations in progress

## Tranche 3 — Mainnet

- [ ] Soroban oracle publishing signed score digests (backlog H5)
- [ ] MCP server for payment agents (backlog H4)
- [ ] Anchor dispute portal
- [ ] Paid API tier live — sustainability without grant dependence

---

## Dependencies and risks

**Wallet partnership is the critical path.** Layer 1 stands alone, but the
most valuable metric — slippage — requires attestors. Pursue wallet
conversations from week one, not after launch.

**Attribution is the main correctness risk.** A TOML declares accounts; it
does not prove ownership. Treat unresolved accounts as unknown rather than
guessing.

**Anchors may object to being scored.** Mitigated by publishing observations
plus an open formula, and by shipping the dispute path early rather than
after the first complaint.
