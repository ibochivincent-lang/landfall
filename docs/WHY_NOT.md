# Why not just use…?

Every question below is one a reasonable engineer asks before adopting
Landfall, and each has a real answer that is not "because we built this."
Where an existing tool is the better choice, this page says so.

---

## …the anchor's own SEP-24 `/info` endpoint?

Because the anchor writes it.

`/info` reports what the anchor's server says it supports. It is a
capability declaration, not a settlement record. An anchor whose payout rail
has been down for a week returns the same `/info` as one settling normally —
nothing in the SEP requires the endpoint to reflect operational reality, and
nothing would stop it being served from a static file.

The same applies to `stellar.toml` and to a status page. All three are the
assessed party describing itself.

**Use `/info` for** what an anchor *offers* — assets, limits, fee structure,
which flows it implements. Landfall does not duplicate that and reads it for
exactly those purposes.

**Use Landfall for** whether the anchor has actually been settling.

---

## …the Anchor Platform?

Because it is the other side of the wire.

The SDF's [Anchor Platform](https://developers.stellar.org/docs/category/anchor-platform)
is the server **an anchor runs** to expose SEP endpoints. Landfall is a
**read-only observer** of what anchor accounts did on the ledger. Nothing
overlaps: if you operate an anchor, run the Anchor Platform, and Landfall will
index your settlement behaviour whether or not you ever hear from us — that is
the point of deriving everything from public data.

| | Anchor Platform | Landfall |
|---|---|---|
| Who runs it | An anchor | Nobody has to — it observes from outside |
| Direction | Serves SEP endpoints | Reads the ledger |
| Needs the anchor's cooperation | It *is* the anchor | No |
| Answers | "What do I support?" | "What did they actually settle?" |

---

## …stellar.expert or a block explorer?

Because an explorer answers *what happened in this transaction*, and the
question here is *what does a year of this account's behaviour imply*.

An explorer will show you every payment an account made. It will not tell you
that the account's inbound volume has been flat for 30 days, that 94% of its
volume moves through one counterparty, or that inbound funds leave again
within ten minutes. Those are aggregations over history with thresholds and
caveats attached, which is the actual work.

Landfall is also **cross-checked against** stellar.expert rather than
competing with it — the original dark-account finding was verified there
before publication, and any figure here should reconcile with what an
explorer shows for the same account.

**Use an explorer for** a specific transaction. **Use Landfall for** a
pattern across an account's history.

---

## …Horizon directly?

You can, and you should be able to — that is a design goal, not a concession.
Every figure Landfall publishes is recomputable from Horizon by a third party
with no permission from anyone, and [`docs/methodology.md`](methodology.md)
documents the arithmetic precisely so you can.

What Landfall adds is that the work is already done, continuously, across
every tracked account, with the observation history retained
([`data/scan-history.ndjson`](../data/scan-history.ndjson)) so a trend exists
rather than only a snapshot. Horizon does not retain full history
indefinitely; an observation not taken at the time cannot be taken later.

If you only need one address once, query Horizon. If you need it for many
addresses, repeatedly, with history — that is this.

---

## …a commercial risk/AML vendor?

Different question, different evidence.

An AML vendor answers "is this address associated with sanctioned or criminal
activity", using proprietary intelligence, attribution data and licensed
feeds. Landfall answers "what does this address's on-chain settlement
behaviour look like", using only public ledger records, with every deduction
traceable to a named flag.

Landfall deliberately ships **no** proprietary fraud feed or "known malicious"
label. No such feed exists that this project can independently verify, and
inventing one would be precisely the failure mode Landfall exists to catch in
other tools. Where third-party claims do appear — fraud reports — they are
attributed to the reporter, never to Landfall, and never scored.

**If you need sanctions screening, buy it.** Landfall is not that and does
not pretend to be.

---

## …an LLM that reads the ledger and tells you what it thinks?

Because a model's confident summary of thin evidence is worse than no
summary.

Landfall does use a model, in exactly one place, under strict constraints:
the AI Investigator writes a plain-language narrative over a list of facts
that were computed deterministically and are displayed alongside it. It is
told nothing else — notably not how many other reports exist about the
subject, since volume is not evidence. The narrative is labelled with the
model that produced it and is `null` when no model is configured, at which
point the facts still stand on their own.

Everything that produces a *number* — the score, the flags, the confidence
rating, the route ranking — is arithmetic, not inference.

---

## …waiting for the anchor to publish this itself?

The party best placed to detect that settlement has stalled is the anchor,
and it is also the party with the least incentive to announce it. That is not
an accusation of bad faith; it is a structural conflict that exists for every
operator regardless of intent.

An independent record does not require anyone to behave badly to be useful.
It requires only that self-reporting and observation can differ, and that a
wallet routing a payment would like to know when they do.
