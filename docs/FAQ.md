# FAQ

Short answers with links to the long ones. For "why not use X instead", see
[WHY_NOT.md](WHY_NOT.md).

---

### An anchor is marked `dark`. Has it failed?

**No, and Landfall does not say it has.** `dark` means no observed on-chain
settlement in over 30 days. Three very different things look identical from
the ledger: an issuer account that never moves by design, a rotated account
still declared in a stale `stellar.toml`, and an operator who has genuinely
stopped paying people.

The figure is what the ledger shows, not a verdict on any operator. If you run
one of these and think a figure is wrong, [DISPUTES.md](../DISPUTES.md).

### An account has no score. Is that good?

No — it is nothing. Absence of a record is not evidence of liveness. In the
oracle, `is_dark()` returns `false` for an account it has never seen, so check
`get_score()` is present before reading `false` as reassurance.

### `returnRate` is 0. Does that mean the anchor is reliable?

No, and this is the most misread field. A return is the *honest* failure mode:
an anchor that accepts value, fails to settle, and simply keeps it produces no
return event at all and scores 0. **A low rate is the absence of one kind of
evidence, not evidence of good conduct.** When there is no inbound traffic the
field is `null` rather than 0 — a rate over nothing is unknown, not zero.

### Why does Trust Check say `unknown` when it gave me a score?

Because `confidence` overrides `riskScore`. A score computed from three
payments is noise, not a finding, so when there is too little history the risk
level returns `unknown` regardless of the arithmetic. **If confidence is
`low`, ignore the score.**

### Three people reported this address. Is it a scam?

Landfall does not say, and deliberately computes nothing from that number.
Three reports is three strangers — possibly three victims, possibly one person
with three browsers. Report volume is never scored, ranked, or blended into
any figure, and no `confirmed` status exists: the strongest state is
`reviewed`, meaning a human read it and the cited evidence checked out, not
that the allegation is true.

Zero reports is equally uninformative. It may just mean nobody affected has
found the page.

### Can Landfall send a payment for me?

**No.** It holds no keys, signs nothing, and takes no custody. Every step that
moves value belongs to your wallet or the anchor. That is a standing design
decision, not a missing feature — [NON_CUSTODY.md](NON_CUSTODY.md).

### Is this financial advice, or sanctions screening?

Neither. It reports observations from a public ledger. It ships no proprietary
intelligence feed and no "known malicious" label, because no feed exists this
project can independently verify and inventing one would be the exact failure
mode it exists to catch. **If you need sanctions screening, buy it.**

### Do I need an API key?

No. Reads are public and anonymous at 30 requests/minute. A key raises your
rate; it never gates access. See [API_REFERENCE.md](API_REFERENCE.md).

### How fresh is the data?

Check `staleHours` on every payload. The scan asks for hourly; the measured
cadence is a median 2.8 h gap because GitHub runs scheduled workflows
best-effort — [BENCHMARKS.md](BENCHMARKS.md). Trust Check is the exception: it
queries Horizon live and is never stale.

### An anchor I care about isn't listed.

Coverage is a curated set of 27 domains, not a census. Absence means untracked,
not nonexistent. Adding one is a change to
`packages/indexer/data/anchors.json`.

### Can I verify these numbers myself?

Yes, and you should be able to — that is a design goal.
[methodology.md](methodology.md) documents the arithmetic, every flag carries
the transaction hashes behind it, and the full observation history is
committed at `data/scan-history.ndjson`. Nothing requires permission from
Landfall or any anchor.

### Why is the oracle only on testnet?

Two things must happen first: a distinct publisher key installed so CI stops
holding the admin key, and the admin account made multisig. Both are
operational, not code. [TRUST.md](TRUST.md).

### Can the oracle be upgraded?

No, deliberately. An admin who can replace the bytecode can redefine what
`publish` means — strictly more power than writing a wrong score, and
invisible from outside. A new schema means a new deployment at a new address.
[ORACLE_SPEC.md](ORACLE_SPEC.md).

### What's the biggest weakness?

**Account attribution.** A `stellar.toml` declares which accounts a domain
operates; nothing proves it. A wrong attribution means a correct finding about
the wrong business — an error that happens before the arithmetic, which no
amount of careful scoring catches. It is listed as the largest correctness
risk in [gaps.md](gaps.md) and is not solved.

Second: nothing outside this repository depends on Landfall yet, which is the
project's own definition of whether it is infrastructure.

### Who runs this?

One person — `ibochivincent-lang`. Single-maintainer bus factor is listed
High/High in [gaps.md](gaps.md). See [GOVERNANCE.md](GOVERNANCE.md).

### How do I report a security issue?

[SECURITY.md](../SECURITY.md). The highest-value bug is anything that lets a
third party influence a published figure.
