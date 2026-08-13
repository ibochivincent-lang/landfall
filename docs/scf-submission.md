# SCF #45 — submission pack

Interest form closes **16 August 2026**. Reviews are rolling; earlier is better
than polished.

Everything below is written to one rule, the same rule the tool itself follows:
**no claim we cannot show you.** Where a fact is missing it is marked `[FILL]`
rather than smoothed over. A grant application that overstates is the same
defect Landfall exists to detect in anchors, and a reviewer who catches one
soft claim will reasonably discount the hard ones.

---

## Part 1 — the interest form

Three fields. Copy them as they are.

### Track

**Integration.**

Reasoning, in case you are asked: Landfall is a new project, which points at
Open. But it is built entirely out of existing Stellar building blocks — SEP-1
for discovery, SEP-24 for why the ledger is sufficient, CAP-67 for the event
stream, SEP-38 for the slippage baseline, Soroban for publication — and it
produces a primitive other Stellar applications consume rather than an end-user
product. That is the Integration track's shape. If a reviewer redirects you to
Open, take it; the substance does not change.

### What are you building?

> Landfall is a settlement-quality record for Stellar anchors, computed
> entirely from the public ledger.
>
> Every existing anchor monitor *interrogates* anchors — pings an endpoint,
> validates a TOML, reads a quote — and records the answer the anchor chose to
> give. Landfall *observes* them. It resolves a home domain to its declared
> accounts via SEP-1, then reads what those accounts actually did on-chain:
> liveness, settlement volume, counterparty concentration, and value returned
> to senders. A TOML file can be edited in ten seconds. Two years of settlement
> history cannot.
>
> This works because SEP-24 puts one leg of every deposit and withdrawal on the
> ledger. So the evidence is already public, already retroactive, and needs no
> cooperation from the anchor being measured. A prober starts collecting the
> day you switch it on; Landfall computed years of history on its first run.
>
> A scan on 12 August 2026 across 13 declared anchor accounts on 5 home domains
> found that **6 of the 13 have processed no on-chain settlement in over 30
> days**, and that at one anchor every account with any payment history is
> dark. Each figure is traceable to the transaction hashes it came from, and
> all of it was cross-checked against stellar.expert before publication.
>
> The code is open source and runs today: indexer, Postgres schema,
> read-only API, a public transaction dashboard, and a Soroban oracle deployed
> to testnet that publishes a digest of each dataset so other contracts can
> route on the same data a wallet reads from the API. Next is turning refund
> detection from a heuristic into a measurement using SEP-24 memo correlation,
> and adding the slippage metric — quoted versus landed — that SEP-38 firm
> quotes make definable and that no one in the ecosystem currently publishes.
>
> Repository: https://github.com/ibochivincent-lang/landfall

That is roughly 300 words. If the form imposes a shorter limit, cut from the
bottom: the last paragraph first, then the code paragraph. Keep the
observe-versus-interrogate contrast and the 6-of-13 finding — those are the
two things that make a reviewer read the rest.

### Referrer

Leave blank unless someone in the Stellar community has genuinely pointed you
here. An invented referral is checkable and fatal.

---

## Part 2 — the full Build Award draft

Only needed if invited. Written now because writing it is how you find out
which parts of your own case are thin.

### The problem

Someone in Lagos sending money home picks an anchor. They cannot tell whether
it is operating. Neither can the wallet that offered it to them. The anchor's
own status endpoint says it is fine, because status endpoints say what the
anchor decides they say.

The consequence is not theoretical. Our first scan found 6 of 13 declared
anchor accounts with no settlement activity for over a month — accounts that
are published in a `stellar.toml` as operational infrastructure. A user routed
to one of those is sending money into silence.

This matters most exactly where Stellar's stablecoin thesis matters most: LatAm
and Africa, where the alternative to a working anchor is not a different
anchor, it is a $12 remittance fee.

### Why nobody has solved it

Reputation products die of cold start. A monitor that begins collecting today
has nothing to say for six months, so nobody uses it, so it never gets the
traffic that would make it worth using.

Landfall does not have this problem, and the reason is specific to Stellar.
Under SEP-24, one leg of every deposit and withdrawal is written to the public
ledger. The evidence already exists, for every anchor, going back years,
whether or not they consented. First run, full history.

### What is built and verifiable today

| | Status | How you check it |
|---|---|---|
| SEP-1 discovery | shipping | `npm run discover` |
| Horizon indexing, resumable cursors | shipping | `npm run scan -- --persist` |
| Liveness, volume, concentration, returns | shipping | `docs/methodology.md` |
| Postgres persistence, 12 tables | shipping | `packages/db/migrations` |
| Read-only API, 8 endpoints | shipping | `packages/api` |
| Transaction dashboard | shipping | `/dashboard` |
| Soroban oracle | **deployed to testnet** | [`CA2IYHF…VICAG`](https://stellar.expert/explorer/testnet/contract/CA2IYHFKTKSJWR5IICY6HFD55BJEGE7OMKISWMLMPFSHLESZYO3VICAG) |
| CAP-67 event ingestion | schema ready, not written | `docs/gaps.md` |
| Attestation, slippage, SDK, MCP | designed, not built | `docs/roadmap.md` |

58 tests pass — 37 offline including a mock Horizon server, 5 integration
against real Postgres, 16 against the contract. MIT licensed. 20 scoped issues
in the tracker, point-tagged for the Drips Stellar Wave.

### How it uses Stellar

Not a generic app that settles on Stellar. It would not port to another chain
without redesign.

- **SEP-1** is the entry point. A home domain resolves to on-chain accounts
  permissionlessly, with no cooperation from the anchor.
- **SEP-24** is why ledger observation is sufficient rather than partial. One
  leg is always public.
- **CAP-67** turns N per-account cursors into one ledger-wide event stream, and
  makes mint and burn distinguishable from transfer rather than inferred.
  Protocol 23 backfills it, so the history is there too.
- **SEP-38** firm quotes with an expiry give slippage a defined baseline: the
  gap between the amount quoted and the amount that landed. That metric does
  not exist in the ecosystem today.
- **Soroban** publishes a digest of each dataset on-chain, so a contract can
  route on the same data a wallet reads from the API — and anyone can
  re-derive the digest and check the two agree. An oracle that asks to be
  trusted has missed the point of being an oracle.

### Milestones

Sized for 3–5 months. Each has an acceptance criterion that is checkable by
someone who does not trust us.

**Tranche 1 — measurement, not estimation**

1. **SEP-24 memo correlation.** Turns refund detection from a heuristic into a
   measurement by tying the two legs of a transaction together through the
   memo. *Accepted when:* every reported return carries `confidence = memo` or
   is labelled `heuristic`, and the two are never summed into one figure.
2. **CAP-67 event ingestion.** One stream instead of per-account paging.
   *Accepted when:* a scan populates `ledger_events` and the metrics computed
   from events match those computed from the REST path on the same window.
3. **Anchor coverage.** From 8 candidate domains to `[FILL — target, 40+?]`.
   *Accepted when:* the census covers `[FILL]` domains with resolution failures
   reported rather than skipped.
4. **Running continuously in public.** *Accepted when:* the dashboard shows a
   scan under 24 hours old, unattended, for 14 consecutive days.

**Tranche 2 — the number nobody publishes**

5. **Signed settlement receipts.** An attestation format letting an anchor or a
   user assert the fiat leg. *Accepted when:* a third party can submit a signed
   receipt and see it reflected, with the signature verified.
6. **Slippage: quoted versus landed.** *Accepted when:* a SEP-38 quote and its
   settled transaction produce a published slippage figure with its inputs.
7. **Oracle publishing from the indexer**, testnet. *Accepted when:* each scan
   writes a digest on-chain and an independent party can re-derive it from the
   published dataset and get the same value.

**Tranche 3 — distribution**

8. **`@landfall/sdk` with `pickAnchor()`**, on npm. *Accepted when:* a wallet
   integrates it in under an hour from the README alone.
9. **MCP server**, so payment agents can query anchor quality directly.
10. **Oracle on mainnet.** *Accepted when:* it carries real scan digests and the
    contract id is published.

### Budget

`[FILL — confirm every line. The arithmetic below is a draft, not a quote.]`

| | Amount | For |
|---|---|---|
| Tranche 1 | `[FILL]` | `[FILL]` person-months at `[FILL]` |
| Tranche 2 | `[FILL]` | |
| Tranche 3 | `[FILL]` | |
| Infrastructure | `[FILL]` | Hosting, database, Horizon egress for 12 months |
| **Total** | `[FILL]` | |

Two things the reviewer will check and you must state explicitly:

- **Part-time or full-time, per person.** The whole budget rests on this and
  leaving it out reads as evasion.
- **Tranche timing.** Each tranche must be submitted within 90 days of the last
  payment or the remainder is forfeit. Say which months you are claiming.

### Team

`[FILL — one line of real background per person, with a link. A name with no
evidence behind it is weaker than no name at all, because it invites the
reviewer to wonder what else is decorative.]`

| Person | Role | Background |
|---|---|---|
| Ibochi Vincent | Lead, indexer and contract | `[FILL]` |
| Faith Adennuga | `[FILL]` | `[FILL]` |
| Oludare Ojo | `[FILL]` | `[FILL]` |
| Adex Adeyemi | `[FILL]` | `[FILL]` |
| Olukorode John | `[FILL]` | `[FILL]` |

Based in Lagos, Nigeria — which is not incidental. The remittance corridors
this measures are the ones the team uses.

### Traction

Stated plainly, because the alternative is being caught:

- **No users. No wallet integrations. No revenue. No letters of support.**
- What exists is a working tool, a published finding, and a public repository.
- `[FILL — if you have had even one conversation with a wallet or anchor by
  submission day, name it. One conversation in progress is worth more here than
  three more features.]`

### Risks

- **Account attribution is unverified.** A TOML declares accounts; nothing
  proves the domain operates them. This is the largest correctness risk in the
  project and it is documented, not hidden. Mitigation is attestation, Tranche 2.
- **The fiat leg is invisible** without attestation. We can prove value moved
  on-chain; we cannot prove anyone was paid. Every published figure says so.
- **Publishing negative findings about named financial businesses.** The code
  of conduct requires factual discussion — if the ledger shows 40 days of
  dormancy we say that, and do not extrapolate to fraud. A dispute route for
  anchors is on the roadmap and is not yet built.
- **Small sample.** 5 resolving domains is a real finding about a small sample,
  not a census of the ecosystem. Tranche 1 addresses this directly.

### What we are not claiming

- Not that dark accounts mean fraud. They mean no on-chain settlement, which is
  what we measured and all we measured.
- Not that a low return rate means an anchor is good. An anchor that accepts
  value, fails to settle and keeps it produces no return event and scores zero.
  Absence of one kind of evidence is not evidence of good conduct, and the
  caveat ships inside the API payload rather than only in the docs.
- Not that this dormancy is undiscoverable elsewhere. stellar.expert labels
  some of these accounts. The difference is that its labels are curated and
  partial; ours are computed and continuous.
- Not that the oracle works. It is deployed to testnet and nothing publishes to
  it yet.

---

## Before you submit

- [ ] Re-run the scan on submission day and update every figure that moved
- [ ] Replace every `[FILL]`, or delete the row
- [ ] Confirm no delivery date is stated beyond 5 months
- [ ] Read it once as a reviewer who has never heard of the project, and strike
      any sentence you could not defend if challenged
