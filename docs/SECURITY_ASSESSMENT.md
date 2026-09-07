# Security assessment — STRIDE and OWASP Top 10:2025

A structured review of what an attacker could do to this project, and what
happens if they succeed. Findings are grounded in source, cited by file and
line, and marked with how they were established: **verified** means it was
demonstrated against a running instance, **read** means it was established by
reading the code.

Frameworks: [STRIDE](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)
for what can go wrong per component, and
[OWASP Top 10:2025](https://owasp.org/Top10/2025/) (released January 2026;
adds Software Supply Chain Failures and Mishandling of Exceptional
Conditions, and absorbs SSRF into Broken Access Control) for coverage.

Assessed: 8 September 2026, against commit `4e76659` and later.
Trust assumptions — what you must trust rather than check — are separate, in
[TRUST.md](TRUST.md).

---

## What is actually at stake

Landfall holds no user funds and moves no money, so the usual "steal the
balance" outcome does not exist here. The asset is **the integrity of a
published record about named businesses.** Two distinct harms:

1. **Falsifying the record.** Making an anchor look better or worse than the
   ledger shows. `SECURITY.md` calls this the worst bug the project can have,
   and it is right: every consumer of this data takes it on the basis that no
   interested party could influence it.
2. **Weaponising the accusation surface.** Fraud reports are allegations
   about real companies. Anything that lets someone file, alter or amplify
   one without the evidence check is a reputational attack with Landfall's
   name on it.

Everything below is ranked by which of those it enables.

---

## Findings

| # | Finding | OWASP 2025 | STRIDE | Severity | Status |
|---|---|---|---|---|---|
| 1 | Any registered user could reach every `/admin` route, including anchor writes | A01 | Elevation of Privilege | **Critical** | Fixed |
| 2 | Unhandled errors returned internal messages to the caller | A10 | Information Disclosure | Medium | Fixed |
| 3 | Oracle admin is a single hot key, no multisig, no timelock | A06 | Tampering / EoP | **High** (prospective) | Open — needs a key decision |
| 4 | No alerting when the scan, oracle publish, or dispatch silently stops | A09 | Repudiation / DoS | Medium | Open |
| 5 | `clientIp()` trusts the leftmost `X-Forwarded-For` | A01 | Spoofing | Low today | Documented assumption |
| 6 | Contract has no external audit | A06 | Tampering | Medium (prospective) | Open — Audit Bank |

### 1. Privilege escalation into `/admin` — Critical, fixed

**A01:2025 Broken Access Control · STRIDE: Elevation of Privilege**

`requireSession()` ([api/[...path].js:206](../api/%5B...path%5D.js#L206)) looks
up `portal_sessions` **first**, then falls back to `admin_sessions`, and
returns the row either way. The `/admin` block gated only on whether a session
existed — not on what kind:

```js
const session = await requireSession(req, db);
if (!session) return adminJson(res, 401, { error: 'Not authenticated.' });
// ...every /admin route followed, with no role check
```

`POST /api/v1/auth/register` is public. It creates a `portal_users` row with
`role: 'developer'`, issues a `portal_sessions` row, and sets the session
cookie. That session satisfied the gate above.

**Verified**, not inferred. Registering an ordinary account and reusing its
cookie returned:

```
GET /api/v1/admin/me      -> HTTP 200
GET /api/v1/admin/health  -> HTTP 200
GET /api/v1/admin/anchors -> HTTP 200
```

The same gate protects `POST`, `PATCH` and `DELETE /api/v1/admin/anchors` —
the tracked anchor set that every published figure derives from. So this was
a path from "filled in a signup form" to "changed what Landfall publishes
about a named business", which is harm #1 above, reachable by anyone.

**Fix:** the gate now requires `session.role === 'admin'` and answers 403
otherwise. Re-verified: all four routes, including the destructive delete,
return 403 to the same account.

**Regression cover:** [api/_lib/admin-authz.test.mjs](../api/_lib/admin-authz.test.mjs)
asserts the role check exists, that no route handler runs before it, and that
registration can never mint an admin. Confirmed by mutation — removing the
check fails the test.

### 2. Internal error messages returned to callers — Medium, fixed

**A10:2025 Mishandling of Exceptional Conditions · STRIDE: Information Disclosure**

The top-level catch returned `err.message` with a 500. Every deliberate 4xx in
the file carries a message written on purpose; that catch is the opposite — it
handles the errors nobody anticipated, where the text comes from Postgres or a
dependency. A `pg` error names tables, columns and constraints (*"duplicate
key value violates unique constraint portal_users_email_key"*); others carry
file paths. That maps the schema for an anonymous caller one failed request at
a time.

**Fix:** the message goes to the log with a short random reference; the
response carries `{ error: 'Internal error.', reference }`, so an operator can
still tie a user's report to a log line.

### 3. Oracle admin key — High, prospective, open

**A06:2025 Insecure Design · STRIDE: Tampering, Elevation of Privilege**

`require_admin` ([packages/contracts/landfall-oracle/src/lib.rs:333](../packages/contracts/landfall-oracle/src/lib.rs))
gates on a single `require_auth()` against one stored address. `set_admin`
takes effect immediately, with no timelock. One key can rewrite every
published score, or transfer the contract.

**Currently dormant:** the oracle is testnet-only and `ORACLE_ADMIN_SECRET` is
unset, so nothing on mainnet depends on it. This must be resolved *before*
mainnet, not after.

The distinction that matters, and that summaries usually blur:

- **Multisig needs no contract change.** `require_auth()` on a `G...` account
  delegates to that account's own signers and thresholds. Making the admin a
  multisig Stellar account is native, requires no redeploy, and is the
  cheapest meaningful hardening available.
- **A timelock does need contract work.** Delaying `set_admin` so a handover
  is visible before it lands cannot be done from the account side.

The contract emits `AdminChanged` on handover, so a takeover is publicly
visible — but see finding 4: nothing watches.

### 4. No alerting — Medium, open

**A09:2025 Security Logging and Alerting Failures · STRIDE: Repudiation, DoS**

Every artifact step in `.github/workflows/scan.yml` is `continue-on-error`,
which is right — a failed sub-step should not block the snapshot commit. But
nothing raises a signal when a step keeps failing. The consequences are
specific:

- The published record silently goes stale. `staleHours` makes this visible to
  anyone who reads a payload, but nobody is watching payloads.
- `AdminChanged` firing unexpectedly on the oracle is exactly the event you
  would want paged about, and no consumer exists for it.
- A repeatedly failing dispatch means degradation webhooks quietly stop.

**Suggested fix:** an `if: failure()` step that opens (or updates) a GitHub
issue. Cheap, needs no external service, and puts the alert where the work is.

### 5. `X-Forwarded-For` trust — Low today, documented

**A01:2025 · STRIDE: Spoofing**

`clientIp()` ([api/[...path].js:263](../api/%5B...path%5D.js#L263)) takes the
leftmost `X-Forwarded-For` entry, which is the attacker-controlled end in a
proxy chain that appends. Every rate limit keys on it: login, registration,
password reset, fraud reports, SEP-10.

**Not exploitable on the current deployment.** Vercel
[overwrites `X-Forwarded-For` and does not forward external IPs](https://vercel.com/docs/security/reverse-proxy),
so the value is platform-supplied. The risk is that this is an undocumented
platform assumption: putting any reverse proxy in front, or moving hosts,
silently converts every rate limit into a no-op. Recorded here and in
[TRUST.md](TRUST.md) so the assumption is explicit rather than implicit.

### 6. No external contract audit — Medium, prospective

**A06:2025 Insecure Design**

16 internal tests, no third-party review, for a contract with authority over a
published reputation record. Stellar runs the
[Soroban Audit Bank](https://stellar.org/grants-and-funding/soroban-audit-bank)
for exactly this: SCF-funded projects, SDF covering most of the cost, 5%
co-payment refundable on timely remediation. Position taken in TRUST.md: no
mainnet oracle before this is applied for.

---

## What held up

Not a clean bill of health — a record of what was checked and found sound, so
a future reviewer knows where the ground has already been covered.

| Area | Result |
|---|---|
| **A05 Injection** | All 60 `db.query` calls parameterised. **Zero** interpolated SQL templates anywhere in `api/` or `packages/` |
| **SSRF** (A01 in 2025) | `assertPublicHostname` ([api/_lib/net-guard.js](../api/_lib/net-guard.js)) resolves DNS and rejects if **any** resolved address is private, loopback, link-local (incl. `169.254.169.254`), IPv6 ULA, or IPv4-mapped-IPv6. Applied at webhook registration **and again at dispatch** — correct, since DNS can change in between |
| **A02 Misconfiguration** | Session cookie is `HttpOnly; Secure; SameSite=Strict`. `Access-Control-Allow-Credentials` appears nowhere, so wildcard CORS cannot carry cookies. Admin responses send no CORS header at all plus `no-store` |
| **A07 Authentication** | Login mints a fresh 32-byte token — no session fixation. Non-existent users are still compared against a dummy hash, equalising timing against enumeration. Password reset returns one generic message either way and stores only a hash of the reset token |
| **A04 Cryptography** | scrypt with a 16-byte random salt for passwords, `timingSafeEqual` for comparison, `randomBytes(32)` for session tokens, Ed25519 throughout for attestations and SEP-10 |
| **IDOR** | Developer routes scope every query by `session.id`, including revocation (`WHERE id = $1 AND user_id = $2`) |
| **A03 Supply chain** | Dependabot across npm, cargo and actions; CI fails on high-severity advisories. Two live advisories (a `fast-uri` SSRF chain, a `qs` DoS) were fixed rather than grandfathered |
| **A08 Data integrity** | Fraud reports require a transaction verified to exist *and* involve the subject. Report volume is never counted. Attestations carry a recomputable digest. Dispute responses are signature-gated |

---

## STRIDE by component

| Component | Spoofing | Tampering | Repudiation | Info disclosure | DoS | EoP |
|---|---|---|---|---|---|---|
| **Public read API** | n/a | Ledger-derived, recomputable | Payloads carry `asOf` | Public by design | Rate-limited¹ | n/a |
| **Developer portal** | scrypt + fresh session token | Scoped by `session.id` | `last_seen_at` tracked | Generic reset message | Rate-limited¹ | **Was open — finding 1** |
| **Admin board** | Session + role | Anchor writes gated | No audit log of admin writes² | `no-store`, no CORS | Rate-limited¹ | Fixed |
| **Fraud reports** | Evidence must involve subject | Volume never scored | `submitted_at` server clock | Reports are public by design | 5/min | Dispute needs a signature |
| **SEP-10 auth** | Signature vs account thresholds | Challenge single-use | Nonce ledger records redemption | No secret ever transmitted | 20/min | Multisig respected |
| **Oracle** | One key — **finding 3** | One key — **finding 3** | `AdminChanged` emitted, unwatched | Public by design | Contract-level | **finding 3** |
| **Scan pipeline** | GitHub OIDC | Recomputable from Horizon | Committed history | n/a | Silent failure — **finding 4** | Workflow secrets |

¹ Rate limits depend on `clientIp()` — see finding 5.
² Admin writes to `tracked_anchors` are not separately logged. Worth adding:
after finding 1, "who changed the tracked set, and when" is a question the
project should be able to answer.

---

## Recommended order

1. **Multisig the oracle admin account** before any mainnet deploy. Native
   Stellar, no contract change, no redeploy.
2. **Failure alerting** on the scan workflow — an `if: failure()` issue-opener.
3. **Apply to the Soroban Audit Bank** before mainnet.
4. **Audit-log admin writes** to `tracked_anchors`.
5. **Watch for `AdminChanged`** once the oracle is live anywhere that matters.

Items 1, 3 and 5 need decisions or credentials rather than code.
