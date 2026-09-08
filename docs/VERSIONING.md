# Versioning

What is versioned, what a version change means, and what will not break
without warning.

---

## What carries a version

| Surface | Scheme | Where |
|---|---|---|
| **`@landfall/sdk`** | Semantic Versioning | [npm](https://www.npmjs.com/package/@landfall/sdk) |
| **REST + GraphQL API** | Path-versioned — `/api/v1/…` | [API_REFERENCE.md](API_REFERENCE.md) |
| **Soroban oracle storage** | Integer, via `storage_version()` | [TRUST.md](TRUST.md) |
| **Database schema** | Numbered, additive migrations | `packages/db/migrations/` |
| **Repository** | [CHANGELOG.md](../CHANGELOG.md), Keep a Changelog format | Repo root |

---

## Pre-1.0, and what that means

`@landfall/sdk` is below 1.0. Under SemVer that means **a minor version may
contain a breaking change**, and this project uses that latitude rather than
pretending otherwise.

**Pin exact versions.** `"@landfall/sdk": "0.1.0"`, not `^0.1.0`, until 1.0.

The bar for 1.0 is not a feature list — it is having an external consumer
whose upgrade would actually hurt. Until something outside this repository
depends on the SDK, a stability promise would be a promise to nobody.

---

## What counts as a breaking change

### SDK

**Breaking:** removing or renaming an export; changing a function signature;
narrowing an accepted input; changing the *shape* of a returned object;
raising the minimum Node version; changing evidence-tier ordering or the
comparison rule.

**Not breaking:** adding an export; adding an optional parameter; **adding a
field to a returned object**; improving an error message; performance work.

Consumers must tolerate new fields appearing in responses.

### API

**Breaking:** removing an endpoint; removing a response field; changing a
field's type or meaning; adding a required parameter; making a public read
require authentication.

**Not breaking:** a new endpoint; a new response field; a new optional
parameter; a wider accepted input; a clearer error message.

**Values are not the API.** A score changing because an anchor's behaviour
changed is the product working. A *scoring formula* change is different —
that alters what a number means, is announced in the changelog, and is
documented in [methodology.md](methodology.md).

---

## The API's `v1` promise

Everything under `/api/v1/` follows one rule: **an existing field keeps its
name, type, and meaning.**

A breaking change means `/api/v2/`, served alongside `v1` — not a redefinition
in place. There is deliberately no `API-Version` header: a header that
silently changes response shapes makes a request non-reproducible from its
URL, and a URL you can paste into a browser and get the same answer from is
worth more here than header negotiation.

**Deprecation.** If an endpoint is ever retired: announced in the changelog,
documented as deprecated in [API_REFERENCE.md](API_REFERENCE.md) with what to
use instead, and kept serving for **at least 90 days**. Nothing has been
deprecated yet.

---

## The oracle's version is not a migration marker

`storage_version()` declares the schema shape. The contract is **immutable by
design** — no upgrade entry point — so a version change means a **new
deployment at a new address**, and consumers migrate deliberately.

It is bumped when the *shape* of stored data changes, never for a behaviour
change that leaves storage alone. Reasoning in [TRUST.md](TRUST.md).

---

## Database migrations

Numbered files in `packages/db/migrations/`, applied in filename order by CI
on every push to `main`.

**Additive by convention.** A migration adds tables, columns, or indexes. It
does not drop or repurpose a column that shipped, because the deployed API and
the database are updated by separate processes and a destructive migration
breaks the running one between them.

Where a value becomes obsolete it is left in place and documented rather than
deleted. `refund.spike` in `user_webhooks.events` was the standing example —
subscribable since the portal shipped, never fired, retained because removing
it would have silently dropped a subscription someone chose.

It has since been given a producer rather than retired, which is the better
outcome of the two and the reason the value was kept: the subscription that
survived is now honoured. See [WEBHOOKS.md](WEBHOOKS.md).

---

## Releases

- All notable changes go in [CHANGELOG.md](../CHANGELOG.md) under
  `Unreleased`, in the same change that makes them.
- A release moves `Unreleased` into a dated, numbered section and tags
  `vX.Y.Z`.
- **`v0.1.0` is the first and only tag**, cut 8 September 2026. `main` is the
  only supported line; fixes are not backported.

---

## Announcements

There is no mailing list or status page. Changes are announced in
[CHANGELOG.md](../CHANGELOG.md) and in commit messages, both of which are
readable without an account.

If external consumers ever appear, this section needs replacing with something
that reaches them — which is a good problem to have and is not today's
problem.
