# API reference

Base URL: `https://landfall-chi.vercel.app`

Everything here is served by one file, [`api/[...path].js`](../api/%5B...path%5D.js).
The interactive playground at [`/docs.html`](https://landfall-chi.vercel.app/docs.html)
runs the same routes; this page is the written reference.

**Reads need no key.** An API key raises your *rate*, never your access —
there is no login wall in front of public data, which would defeat the point
of publishing a permissionless record.

---

## Conventions

### Staleness on every payload

Any response derived from a scan carries:

| Field | Meaning |
|---|---|
| `asOf` | ISO 8601 timestamp of the scan the data came from |
| `staleHours` | Hours since that scan finished |

This is deliberate. A consumer must be able to see that data is a month old
without reading a changelog — so a stale answer is visibly stale rather than
quietly served as current. **Check `staleHours` before acting on a figure.**

### Errors

Every error is JSON with an `error` string, and where useful a machine-readable
`reason`:

```json
{ "error": "address must be a Stellar public key (G...) or a transaction hash." }
```

| Status | Meaning |
|---|---|
| `400` | Malformed input — the message says what was wrong |
| `403` | A signature was presented and did not verify |
| `404` | No such resource |
| `405` | Method not allowed on a real path (writes are explicitly allow-listed) |
| `409` | Conflict — e.g. a report already carries a response |
| `429` | Rate limit exceeded |
| `502` | An upstream (Horizon) could not be reached — **not** a statement about the data |
| `503` | `DATABASE_URL` is not configured on the deployment |

`502` versus a negative finding matters: "Horizon is unreachable" is not
"this address is bad". Consumers should treat an upstream failure as
**unknown**, never as a pass — see [`examples/x402-payee-check`](../examples/x402-payee-check),
where a failed check refuses the payment.

### Rate limits

| Caller | Limit |
|---|---|
| Anonymous | **30 requests/minute**, keyed by client IP |
| With `x-api-key` | That key's own `rate_limit_per_min` |
| `POST /v1/fraud-reports` | 5/min |
| `POST /v1/fraud-reports/:id/dispute` | 10/min |
| `POST /v1/fraud-reports/:id/investigate` | 10/min |
| `GET /v1/trust-check` | 20/min |

Present a key as `x-api-key: lf_live_…`. Keys are created in
[`/portal.html`](https://landfall-chi.vercel.app/portal.html), stored hashed,
and revocable. An invalid key is not an error — it falls back to the
anonymous limit.

### Caching

Successful reads set `Cache-Control: public, s-maxage=<n>` — a **shared**
(CDN) max-age, not a browser one, so an edge caches while a client always
revalidates. `<n>` defaults to 60, is 300 for the slowest aggregate, and 0
for writes and live reads. Non-200 responses are always `no-store`, so an
error is never cached as though it were an answer.

---

## Read endpoints

### `GET /health`

Liveness. Returns `{"ok":true}` when the database answers.

---

### `GET /api/v1/anchors`

Every tracked account with its metrics, from the latest scan. **This is the
authoritative endpoint** — reconcile webhooks against it.

```bash
curl -s https://landfall-chi.vercel.app/api/v1/anchors
```

```json
{
  "asOf": "2026-09-08T12:23:20.818Z",
  "staleHours": 0.09,
  "accounts": [
    {
      "account": "GAWODAROMJ33V5YDFY3NPYTHVYQG7MJXVJ2ND3AOGIHYRWINES6ACCPD",
      "domain": "cowrie.exchange",
      "name": "Cowrie Integrated Systems",
      "state": "slow",
      "inbound": 24,
      "outbound": 1,
      "returns": 0,
      "returnRate": 0,
      "hoursSinceActivity": 348.22,
      "topCounterpartyShare": 0.9176
    }
  ],
  "reliability": {
    "cowrie.exchange": {
      "score": 62,
      "grade": "D",
      "status": "degraded",
      "factors": { "liveness": 20, "settlement": 32, "volume": 10 },
      "recommendation": "…"
    }
  }
}
```

`reliability` is keyed by **domain**, not by account — an anchor's several
accounts roll up to one grade. `factors` breaks the score into the three
components it is summed from, so the number can be checked rather than
trusted.

| Field | Meaning |
|---|---|
| `state` | `live` · `slow` · `dark` · `no_activity` — see [methodology.md](methodology.md) for thresholds |
| `hoursSinceActivity` | Since the account's last on-chain settlement |
| `topCounterpartyShare` | Fraction of volume through its single largest counterparty (0–1) |
| `returnRate` | `null`, not `0`, when there is no inbound traffic. A rate over nothing is unknown, not zero |

**`no_activity` is not `dark`.** An issuer account moves value through
trustlines rather than payments, so an empty payment history is normal
structure, not dormancy.

**On `returnRate`:** a return is the honest failure mode. An anchor that
accepts value, fails to settle, and keeps it produces *no* return event and
scores 0. A low rate is the absence of one kind of evidence, not evidence of
good conduct.

*(The static snapshot at `/api/v1/anchors.json` additionally carries a
`returnRateCaveat` string spelling this out. The live endpoint does not — the
caveat is here instead.)*

---

### `GET /api/v1/anchors/:domain/payments`

A page of indexed payments, scoped to one anchor.

| Query | Default | Meaning |
|---|---|---|
| `direction` | both | `in` or `out` |
| `asset` | all | Asset code filter |
| `before` | — | Keyset cursor; pass the previous page's last id |
| `limit` | 50 | Max 200 |

---

### `GET /api/v1/anchors/:domain/health-check`

Pre-flight score for a wallet about to route to this anchor. Returns a 0–100
reliability score and A–F grade derived from liveness, throughput and refund
rate. Every component is documented in [methodology.md](methodology.md) and
recomputable by hand.

---

### `GET /api/v1/badges/:domain.svg`

An SVG status badge. Sets its own `Content-Type: image/svg+xml`.

```markdown
![Landfall](https://landfall-chi.vercel.app/api/v1/badges/example-anchor.com.svg)
```

---

### `GET /api/v1/assets`

Payment counts grouped by asset.

### `GET /api/v1/corridors`

Cross-asset settlement flows grouped by asset pair, from path payments —
`USD → NGN`, `EUR → BRL`. Backs `/corridors` and its CSV export.

---

### `GET /api/v1/trust-check?address=…`

Counterparty signals for **any** Stellar address, live from Horizon.
Needs no database, so it stays up when the rest does not.

Accepts a `G…` address or a 64-character transaction hash (resolved to its
source account).

```bash
curl -s "https://landfall-chi.vercel.app/api/v1/trust-check?address=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
```

| Field | Meaning |
|---|---|
| `riskScore` | 0–100. Every deduction traces to a named flag — recomputable by hand |
| `riskLevel` | `low` · `medium` · `high` · `unknown` |
| `confidence` | `low` · `medium` · `high` — **overrides the score.** A score from three payments is noise, not a finding |
| `flags[]` | `{ id, severity, summary, detail, evidenceTxHashes[] }` |
| `age` | Observed history. `isLowerBoundOnly` is always true — Horizon does not retain forever |
| `concentration` | Top counterparty share and distinct counterparty count |
| `forwarding` | Inbound funds leaving again quickly |
| `limits` | Prose caveats that ship with the result |

**A flag is a ledger fact, not an accusation.** The same pattern that looks
like risk is also an ordinary automated wallet. Read `evidenceTxHashes` and
check it yourself.

**If `confidence` is `low`, do not use `riskScore`.** That combination means
there is too little history to say anything, and `riskLevel` returns
`unknown` regardless of the arithmetic.

---

### `GET /api/v1/fraud-reports/:subject`

Third-party reports about an address, with the disclaimer attached.

```json
{
  "subject": "G…",
  "reports": [ { "id": "1", "evidenceTxHash": "…", "category": "did_not_receive",
                 "note": "…", "status": "unreviewed", "submittedAt": "…",
                 "disputedAt": null, "disputeNote": null } ],
  "total": 1,
  "disputed": 0,
  "summary": "…",
  "disclaimer": "These are claims by third parties, not findings by Landfall…"
}
```

**Report volume is never scored.** Three reports is three strangers, which may
be three victims or one person with three browsers. There is deliberately no
aggregate field to render instead of the prose, and `status` has no
`confirmed` value — the strongest state is `reviewed`, meaning a human read it
and the evidence checked out, not that the allegation is true.

Zero reports is **not** a clean bill of health. It may equally mean nobody
affected has found the page.

---

### `GET /api/v1/fraud-reports/:id/investigation`

The Analyzed-stage result for one report, if it has been run.

| Field | Meaning |
|---|---|
| `citedFacts[]` | Deterministic, computed with **no AI**. Always present |
| `relevantSignals[]` | The subject's own warning/high Trust Check flags |
| `narrative` | Optional AI prose over exactly those facts. `null` when no model is configured |
| `narrativeModel` | Which model wrote it, or `null` |

`404` with `"This report has not been investigated yet."` when none exists.

The narrative is never given how many other reports exist about the subject —
volume is not evidence, and handing a count to a model invites it to read one.

---

### `GET /api/v1/fraud-reports/:id/attestation`

A signed attestation that the reported party responded and controls the
address. **It never covers the accusation** — only the response.

---

### `GET /api/v1/fiat-confirmations/:chain/:reference`

Status of one recipient fiat-leg confirmation, if any.

---

### `GET /api/v1/auth?account=G…`

A SEP-10 challenge transaction to sign. See [SEP_COVERAGE.md](SEP_COVERAGE.md).

Sequence number 0 — an account can never have it, so the challenge is
unsubmittable. A challenge that could be submitted is a blank cheque.

**Currently returns `503` in production.** `SEP10_SERVER_SECRET` is not set, and
nothing is half-enabled: no challenge is issued and no token can be minted.
The route is implemented and tested; it is switched off, not missing.

---

## Write endpoints

Each is explicitly allow-listed past a GET-only guard, enforced by
`api/_lib/routes.test.mjs` — a test that exists because three write routes
once returned `405` in production from the day they shipped.

### `POST /api/v1/graphql`

GraphQL over the same resolvers as REST. Schema in [GRAPHQL_API.md](GRAPHQL_API.md).

### `POST /api/v1/intent`

Rank routes for a payment intent and return an executable plan.

Commercial terms (`rateSpread`, `feePercent`) come from **the caller**, because
they are each anchor's own published figures, not Landfall's. The reliability
grade is always overwritten from Landfall's ledger scan regardless of what you
supply — a route-ranking tool where the ranked party supplies its own score
would not be one.

Every plan step carries an `actor`: `user` · `wallet` · `anchor` · `landfall`.
**`landfall` never appears on a step that moves value.**

### `POST /api/v1/x402/check-payee`

Trust Check every Stellar payee in an x402 402 response's `accepts` array.

```bash
curl -X POST https://landfall-chi.vercel.app/api/v1/x402/check-payee \
  -H "Content-Type: application/json" \
  -d '{"accepts":[{"scheme":"exact","network":"stellar:pubnet","asset":"C…","amount":"10000","payTo":"G…","maxTimeoutSeconds":60,"extra":{}}]}'
```

Returns one assessment per requirement, **in input order**, each either
`supported: true` with a `trustCheck`, or `supported: false` with a `reason`.
A payee is never silently dropped, and one bad payee never removes another's
answer. Unsupported results carry `retryable` so a transient Horizon outage
cannot read the same as "that account does not exist".

### `POST /api/v1/fraud-reports`

File a report. The cited transaction is verified to exist **and** involve the
subject *before* a row is written; a report that fails is rejected, not stored
at low weight. Self-reports are refused.

### `POST /api/v1/fraud-reports/:id/dispute`

The reported party responds. Gated on an Ed25519 signature from the reported
address — the subject comes from the stored report, never the request, so a
caller cannot name an address they control and pass the check against someone
else's report. One response per report.

### `POST /api/v1/fraud-reports/:id/investigate`

Run the Analyzed stage. Computes cited facts deterministically; asks a model
for a narrative only when one is configured.

### `POST /api/v1/fiat-confirmations`

Recipient self-report that a fiat leg landed — a `DERIVED`-tier evidence
input. Sender reports never bind; see [FIAT_CONFIRMATION.md](architecture/FIAT_CONFIRMATION.md).

### `POST /api/v1/auth`

Verify a signed SEP-10 challenge and mint a token. The signature must meet the
account's **medium** threshold, so a multisig account is multisig here too.

---

## Not offered, deliberately

| Not here | Why |
|---|---|
| Anything that moves value | Landfall holds no keys and takes no custody. See [VERIFIED_ROUTES.md](architecture/VERIFIED_ROUTES.md) |
| An x402 `/verify` or `/settle` facilitator | That routes funds. Stellar already has a facilitator |
| A "known malicious" label or fraud feed | No feed exists this project can independently verify, and inventing one is the failure mode Landfall exists to catch |
| An aggregate score over report volume | Counts are not verdicts |

---

## Related

- [WEBHOOKS.md](WEBHOOKS.md) — push instead of poll
- [MCP.md](MCP.md) — the same data as agent tools
- [`@landfall/sdk`](https://www.npmjs.com/package/@landfall/sdk) — typed client
- [methodology.md](methodology.md) — how every number is computed
- [TRUST.md](TRUST.md) — what you must trust to rely on any of this
