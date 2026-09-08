# For anchor operators

If you operate a Stellar anchor and found this because Landfall published
something about you, start here.

**Short version:** Landfall reads the public ledger. It did not ask your
permission, it does not need your cooperation, and it cannot be persuaded to
show a number other than what your accounts actually did. What it *can* do is
be wrong — and if it is, that is a bug and you are the person best placed to
report it.

---

## How you ended up here

1. Your home domain publishes a `stellar.toml` (SEP-1).
2. That file declares the accounts you operate.
3. Landfall reads those accounts' payment history from Horizon.
4. Liveness, volume, counterparty concentration and refund rate are computed
   from what those accounts did.

**No step requires anything from you.** That is the design: an anchor
monitor that needs an anchor's cooperation measures cooperation, not
settlement.

---

## Reading your own record

```bash
curl -s "https://landfall-chi.vercel.app/api/v1/anchors" \
  | jq '.accounts[] | select(.domain == "your-domain.com")'

curl -s "https://landfall-chi.vercel.app/api/v1/anchors/your-domain.com/health-check"
```

Or open [`/anchors.html`](https://landfall-chi.vercel.app/anchors.html).

### What each field means, and does not

| Field | Means | Does **not** mean |
|---|---|---|
| `state: dark` | No observed on-chain settlement in over 30 days | That you have failed, stopped, or done anything wrong |
| `state: no_activity` | No payment history at all | The same as `dark` — an issuer moving value through trustlines looks like this and is normal |
| `hoursSinceActivity` | Since the last on-chain settlement we observed | Since you last did business — a fiat leg is invisible to the ledger |
| `topCounterpartyShare` | Fraction of volume through your largest counterparty | Anything about who that counterparty is |
| `returnRate` | Returns as a fraction of inbound | Quality. See below |
| `returnRate: null` | No inbound traffic, so the rate is **unknown** | Zero |

**On `returnRate`, the field most often misread in your favour:** a return is
the *honest* failure mode. An anchor that accepts value, fails to settle, and
simply keeps it produces no return event and scores 0. A low rate is the
absence of one kind of evidence, not evidence of good conduct. We publish that
caveat next to the number rather than letting a low score flatter anyone.

**`dark` is not an accusation.** Three very different things look identical
from the ledger: an issuer account that never moves by design, a rotated
account still declared in a stale TOML, and an operator who has genuinely
stopped. We say which of those we cannot distinguish, every time the figure
appears.

---

## The most common complaint, and its fix

> *"You're showing an account we stopped using two years ago."*

Then your `stellar.toml` still declares it. Landfall attributes accounts to
the domain that publicly claims them, and **will not silently drop an account
a domain still claims** — doing so would let anyone quietly remove their worst
account from a public record.

**The fix is yours and takes effect on the next scan:** remove the account
from `ACCOUNTS` in your `stellar.toml`. Nothing needs to be requested from us.

This cuts both ways, and in your favour more often than not: a stale TOML is
also how a dormant issuer account drags down a domain that is settling
perfectly well through its other accounts.

---

## If a figure is actually wrong

Genuinely wrong means: the arithmetic does not match
[the documented method](methodology.md), the ledger records were misread, or
an account is attributed to you that you do not operate.

**[Open an issue](https://github.com/ibochivincent-lang/landfall/issues)** with
the account, the figure, and what the ledger shows instead. No lawyer needed,
and a correction is treated as a bug — which is to say, welcome.

Before that, it is worth recomputing yourself. Every flag carries the
transaction hashes behind it, the arithmetic is documented, and the full
observation history is committed at
[`data/scan-history.ndjson`](../data/scan-history.ndjson). Most disagreements
resolve there, in one direction or the other.

**If someone filed a fraud report about your address**, you can answer it by
proving you control the address — a signature, never a password, and your
response attaches to the report wherever it appears. See
[DISPUTES.md](../DISPUTES.md).

**What will not happen** is a correct figure being withdrawn because it is
unflattering. That policy is written down in
[TAKEDOWN.md](TAKEDOWN.md) rather than improvised per request.

---

## Things you can do that make the record better

None of these are required, and none buy you a better score.

**Keep your `stellar.toml` current.** It is the only input you control, and a
stale one is the largest source of wrong attribution — the one error that
happens *before* the arithmetic and which careful scoring cannot catch.

**Run SEP-38.** Landfall queries every tracked anchor's quote server hourly so
a published rate can be a real quote rather than a catalogue estimate. Today
almost no tracked anchor answers with a usable quote for a corridor we show,
so most rate cells are still estimates — labelled as such. If you run SEP-38
against a live corridor, your rate stops being an estimate.

**Declare what you actually serve.** `scripts/probe-capabilities.mjs` records
declared-versus-observed for SEP-6, SEP-12 and SEP-31: whether your TOML
declares a service, and whether that endpoint answers. Both are published, and
the gap between them is itself a finding — a declared endpoint that refuses
connections is reported as exactly that.

**Embed your badge, if you want to.** `GET /api/v1/badges/your-domain.svg`
renders live status. It shows whatever the ledger says, including when that is
unflattering, which is the only reason it is worth anything.

---

## Getting added

Landfall tracks a curated set — around 27 domains, not a census. The exact
count moves between scans, so
[`/api/v1/anchors`](https://landfall-chi.vercel.app/api/v1/anchors) is the
live answer rather than any number written here.

**Absence means untracked, not nonexistent** — or that a scan failed to reach
a domain it does track. The response tells you which: check `coverage.complete`
and the `coverage.missing` list, which names any tracked domain that dropped
out and why. See [API_REFERENCE.md](API_REFERENCE.md).

To be added: [open an issue](https://github.com/ibochivincent-lang/landfall/issues)
with your home domain. The requirement is a `stellar.toml` that resolves and
declares accounts; everything else follows from the ledger.

**Being tracked is not an endorsement, and we will publish whatever we
observe** — including a `dark` classification a week after you ask to be
added. If that is not acceptable, do not ask. Nobody is added to make a point,
and nobody is excluded to spare anyone.

---

## What Landfall will never ask you for

- A secret key, in any form, for any reason
- Payment for a better score, or payment at all
- An agreement, an NDA, or a right of review before publication
- Personal data about your customers — SEP-12 is probed for existence only

If something claiming to be Landfall asks for any of those, it is not us.

---

## Related

- [methodology.md](methodology.md) — the arithmetic behind every figure
- [DISPUTES.md](../DISPUTES.md) — answering a report about your address
- [TAKEDOWN.md](TAKEDOWN.md) — corrections versus removal demands
- [API_REFERENCE.md](API_REFERENCE.md) · [FAQ.md](FAQ.md)
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) — the tone we hold ourselves to when publishing about you
