# Takedown and correction requests

What happens when someone demands that a published finding be removed.

[JURISDICTIONAL.md](JURISDICTIONAL.md) names this as the most likely legal
event this project will actually face, and until now there was no rehearsed
answer. Deciding it while a letter is on the desk is how projects make
decisions they regret — so it is decided here, in advance, in public.

**This is not legal advice**, and it binds nobody but this project.

---

## The distinction everything rests on

| | |
|---|---|
| **A correction** | The published figure is *wrong* — bad arithmetic, misread input, or an account attributed to a domain that does not operate it |
| **A takedown** | The published figure is *right*, and someone would prefer it were not visible |

**Corrections are always welcome and are treated as bugs.** They are the most
valuable report this project can receive, and the person raising one is doing
Landfall a favour whether or not they intend to.

**A correct finding is not removed on request.** Not because complaints do not
matter, but because a record that disappears under pressure is not a record —
and everyone else relying on it has no way to know which findings survived on
merit and which survived because nobody objected.

---

## If you think a figure is wrong

Fastest route, in order of how quickly it resolves:

1. **Check the evidence yourself.** Every flag carries the transaction hashes
   behind it, and [methodology.md](methodology.md) documents the arithmetic.
   Most disputes end here, in either direction.
2. **[Open an issue](https://github.com/ibochivincent-lang/landfall/issues)**
   with the account, the figure, and what the ledger shows instead.
3. **Sign a dispute** if it concerns a fraud report about an address you
   control — [DISPUTES.md](../DISPUTES.md). Your response attaches to the
   report wherever it appears.

You do not need a lawyer for any of this, and involving one will not make it
faster.

### What "wrong" means here

| Genuinely wrong | Not wrong |
|---|---|
| The arithmetic does not match the documented method | The number is unflattering |
| The account is not operated by the domain it is attributed to | The classification is unflattering but correct |
| Ledger records were misread | The sample is small — that is disclosed, not hidden |
| A caveat that ships with the figure is missing or incorrect | Your `stellar.toml` declares accounts you no longer use |

That last one comes up often enough to state plainly: if a domain's own SEP-1
TOML declares an account, Landfall attributes it to that domain. **The fix is
to update your TOML**, which is yours to change and takes effect at the next
scan. Landfall will not silently drop an account a domain still publicly
claims.

---

## If you demand removal of an accurate finding

The answer is no, and here is the reasoning rather than a wall.

**The finding is true, and demonstrably so.** Every figure is derived from
public ledger records that anyone — including you, including your engineers —
can recompute from Horizon without Landfall's cooperation. Removing a
verifiable statement of public fact makes Landfall less useful to everyone
without making the underlying ledger say anything different.

**It is bounded.** Landfall says what the ledger shows, not what it means.
`dark` means no observed on-chain settlement in 30 days and explicitly does
not mean an anchor has failed — that caveat ships in the payload, not just in
the docs. No published figure asserts intent, misconduct, or insolvency.

**You already have a right of reply**, and it does not require our
cooperation or agreement.

### What will happen

1. **The request is read properly**, and checked for a factual error — a
   demand for removal often contains one, and if it does, that half is treated
   as a correction and fixed on its merits.
2. **A reply within a reasonable time**, saying which parts are corrections
   (actioned) and which are removal requests (declined), with reasons.
3. **If a court with jurisdiction orders removal**, that order is complied
   with. This project is operated by one person and is not in a position to
   litigate, which is a resource limit and is stated as one.
4. **Compliance is disclosed.** If content is removed under legal compulsion,
   the removal is recorded in [gaps.md](gaps.md) and the changelog — noting
   *that* something was removed and under what kind of order, even where the
   content itself cannot be restated. A record that quietly shrinks is worse
   than one with a visible hole in it.

### What will not happen

- Removal because a finding is commercially inconvenient
- Quiet removal — see point 4
- A private arrangement to exclude an account from scanning
- Editing a figure to something more agreeable while presenting it as measured

That last one is the line the whole project exists on. A record that can be
negotiated is not a record.

---

## For individuals, not businesses

The above is written about companies operating anchors. If you are a private
individual and an address describing you is indexed, say so — the balance is
different, the data is pseudonymous rather than anonymous, and there is a real
argument that a person is not a public business. Open an issue or use the
dispute path.

Landfall indexes accounts declared by a domain's SEP-1 TOML as operating
that domain's anchor. If your personal address has ended up in that set, that
is most likely an attribution error, which is a correction.

---

## Security reports are a different route

A vulnerability is not a takedown. See [SECURITY.md](../SECURITY.md) —
anything that lets a third party influence a published figure is the highest
value report this project can receive, and is handled privately.

---

## Honest limitations

- **One maintainer.** Response times depend on one person being available.
  [GOVERNANCE.md](GOVERNANCE.md) is candid about this.
- **No legal counsel.** No lawyer has reviewed this page or the project.
- **No jurisdiction of establishment declared**, so which court could order
  what is genuinely unsettled. Stated in
  [JURISDICTIONAL.md](JURISDICTIONAL.md) §5.
- **No takedown has ever been received.** This policy is untested, written in
  advance precisely so the first one is not answered improvised.

---

## Related

- [JURISDICTIONAL.md](JURISDICTIONAL.md) · [DISPUTES.md](../DISPUTES.md) · [methodology.md](methodology.md)
- [gaps.md](gaps.md) — where any compelled removal would be recorded
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) — tone, which this page assumes on both sides
