# Contributor ladder

How someone goes from a first PR to holding responsibility here, and what
each rung actually grants.

**Current state: one maintainer, no other contributors.** This page describes
a path nobody has walked yet. It exists because `gaps.md` lists the
single-maintainer bus factor as High likelihood, High impact, and a ladder
nobody can find is not a ladder.

For how to make a change, see [CONTRIBUTING.md](../CONTRIBUTING.md). This is
about what comes after doing that repeatedly.

---

## The rungs

### 1. Contributor

**Anyone who lands a PR.**

Start with a `good first issue`, and **wait to be assigned before writing
code** — an unassigned issue is not yours, and duplicated work is the fastest
way to make contributing feel pointless.

Expectations are the same as for anyone: tests for behaviour you change, and a
commit message explaining *why* rather than restating the diff. This
repository's history is a reasoning record; a message that says "fix bug"
throws away the part worth keeping.

### 2. Triager

**Roughly 3–5 merged PRs, plus useful issue activity.**

Grants: issue triage — labelling, closing duplicates, asking for
reproductions, assigning `good first issue` to newcomers.

Why this rung exists first: triage is where you learn what the project refuses
to do, which is more of this codebase's design than what it does. Someone who
has closed a few "why not just add an execute button" issues understands
[NON_CUSTODY.md](NON_CUSTODY.md) better than someone who has read it.

### 3. Reviewer

**Roughly 10 merged PRs across more than one package, and demonstrated
judgement on Class 3 changes.**

Grants: review authority. A Reviewer's approval merges ordinary engineering —
bug fixes, endpoints, docs, performance.

Not granted: Class 1 or Class 2 changes (see
[GOVERNANCE.md](GOVERNANCE.md)). A change to a scoring formula alters what a
published number means about a named business, and stays with the maintainer
regardless of how many reviewers exist.

What is actually being assessed: whether you push back. A reviewer who
approves everything adds latency, not safety. The useful signal is having
said "this number isn't traceable to a ledger record" at least once.

### 4. Maintainer

**Sustained Reviewer activity, and — the real bar — being someone the project
can afford to depend on.**

Grants: merge rights on all classes, and a **second signer on the oracle admin
account**.

That last part is the point. Today one person can hand over the reputation
record alone; a second admin signer is the change that makes the word
"governance" mean something. It is the reason this ladder exists.

Deliberately separate: **merge rights and key access are not the same
grant.** Someone can be a Maintainer for code before holding a key that writes
to the ledger, and for most people that is the right order.

---

## What is not a rung

**Volume.** Twenty typo fixes is not a Reviewer. The rungs above say "roughly"
because a count is a proxy for judgement, not a substitute.

**Bounty completion.** If bounties ever exist, completing one is completing a
task, not advancement.

**Being first.** Nobody is owed a rung for showing up early.

---

## Removal

Rungs go down as well as up. Inactivity for six months moves someone back a
rung — no judgement implied, just accuracy about who is actually holding
something.

A key holder who becomes unreachable is a live problem, not an administrative
one: [KEY_ROTATION.md](KEY_ROTATION.md) covers the rotation, and the admin
account's threshold must be re-checked so it never requires more signatures
than there are reachable signers. **That failure is unrecoverable**, which is
why the ladder cares about reachability at all.

---

## If you are reading this because you want to help

The most valuable contributions right now are not code:

1. **An external consumer.** A wallet calling `pickAnchor()`, an agent calling
   the MCP server. The project's own test of whether it is infrastructure, and
   nothing in this repository can close it.
2. **A verified non-Stellar anchor address.** Every non-Stellar chain reports
   `unresolved`. This is research, not code — and a guessed address
   misattributes settlement to the wrong business.
3. **Telling us a published number is wrong.** With the ledger records that
   show it. That is the most useful issue this project can receive.
