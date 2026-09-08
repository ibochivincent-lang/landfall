# Terms of use

Plain terms for the public API, the website, and the SDK. Short on purpose —
a long agreement for a free read-only API mostly protects nobody.

**Not a contract drafted by a lawyer.** No legal review has been obtained. See
[JURISDICTIONAL.md](JURISDICTIONAL.md), which says the same.

Last updated: 8 September 2026.

---

## What you get

Everything Landfall publishes — the API, the site, the SDK, the MCP server —
is free to use, including commercially, with no account required for reads.

The code is [MIT licensed](../LICENSE). The published data is derived from
Stellar's public ledger, which nobody owns; Landfall claims no rights over the
underlying facts and does not restrict what you do with them.

**No attribution is required.** It is appreciated, mostly because it helps
someone reading your output trace a figure back to how it was computed.

---

## What you should not do

- **Do not present Landfall figures as your own measurements** if a reader
  would act on them. Not a legal demand — a request that findings stay
  traceable, since a number nobody can trace back to its method is the thing
  this project exists to replace.
- **Do not strip the caveats.** Every payload carries `asOf`/`staleHours`, and
  results carry limits text and disclaimers. Rendering a score without them
  produces exactly the false confidence the score is designed to avoid.
- **Do not use the fraud-report endpoint to publish allegations you cannot
  evidence.** Reports require a verifiable transaction for a reason.
- **Do not attempt to exceed rate limits** by rotating IPs or keys. Limits are
  in [API_REFERENCE.md](API_REFERENCE.md); if they are too low for a
  legitimate use, ask.

---

## No warranty, and what that actually means

The service is provided **as is, with no warranty of any kind**, and its
availability is not guaranteed. Concretely, and more usefully than a
disclaimer block:

- **Data can be stale.** Check `staleHours`. The scan is hourly *by intent*;
  GitHub runs scheduled workflows best-effort, and the measured cadence is a
  median 2.8 h gap.
- **Data can be wrong.** Account attribution is unverified — a TOML declares
  accounts and nothing proves the domain operates them. This is the largest
  known correctness risk and it is documented in [gaps.md](gaps.md).
- **Coverage is a curated set, not a census.** Absence of an anchor means it is
  not tracked, not that it does not exist.
- **The service can go down.** Treat an unreachable or stale Landfall as
  **unknown**, never as a pass.

**You are responsible for decisions you make using this data.** Landfall
reports what a public ledger shows. It does not tell you whom to pay, and it
holds nothing belonging to you — see [NON_CUSTODY.md](NON_CUSTODY.md).

---

## What Landfall is not

| | |
|---|---|
| Not financial or investment advice | It reports observations, not recommendations |
| Not a sanctions or AML screening service | It ships no proprietary intelligence feed. If you need screening, buy it — see [WHY_NOT.md](WHY_NOT.md) |
| Not a custodian or payment service | It holds no funds and signs no payments |
| Not a certification of any anchor | A grade is arithmetic over ledger facts, not an endorsement |

---

## If a finding about you is wrong

If you operate an address Landfall describes and believe a figure is
incorrect, [DISPUTES.md](../DISPUTES.md) is the route. A signature from the
address attaches your response to the record wherever it appears.

Landfall does not adjudicate between a report and a response, and does not
claim to know which is right.

**A correct finding will not be removed on request.** Corrections are for
errors — wrong arithmetic, wrong attribution, misread input.

---

## API keys

Keys raise your rate limit; they never gate access to public data. A key may
be revoked if it is used to circumvent limits or to abuse the write endpoints.
Reads remain available anonymously either way.

---

## Changes

These terms may change; material changes go in [CHANGELOG.md](../CHANGELOG.md)
with a dated entry. There is no mailing list — see
[VERSIONING.md](VERSIONING.md) on announcements.

---

## Contact

Issues and disputes: the [GitHub repository](https://github.com/ibochivincent-lang/landfall).
Security: [SECURITY.md](../SECURITY.md).
