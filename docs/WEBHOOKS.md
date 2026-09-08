# Webhooks

Landfall can POST to your endpoint when a tracked anchor account's settlement
behaviour degrades. Subscriptions are managed in the developer portal
(`/portal.html`); delivery is performed by `scripts/dispatch-webhooks.mjs`
immediately after each hourly scan.

Everything below is the behaviour of the code that ships, not a plan.

---

## Event types

| Event | Fires when | Notes |
|---|---|---|
| `anchor.degraded` | An account moves to a **weaker** liveness state | The event that actually occurs. Ranking is `live` (3) > `slow` (2) > `no_activity` (1) > `dark` (0); a move to a lower rank fires, a move upward never does |
| `anchor.dark` | An account reaches `dark` specifically | Kept with its original payload so existing subscribers are unaffected. **Be aware it is rare:** across a month of stored scans, zero transitions *into* dark were observed — every dark account was already dark when first seen |
| `refund.spike` | An account's refund rate rises materially, **on enough volume for the rate to mean anything** | Subscribable since the portal shipped, with no producer until now. See the gate below — it is the whole design |

A recovery — `slow` → `live`, or a falling refund rate — deliberately fires
nothing. An alert that wakes you for good news trains you to ignore alerts.

### The refund.spike gate, and why it exists

Three conditions must all hold:

| Condition | Value | Why |
|---|---|---|
| Inbound payments | **≥ 25** | A rate over a thin sample is not a finding |
| Absolute rise | **≥ 2 percentage points** | Stops 0.1% → 0.2% firing on a doubling |
| Relative rise | **≥ 50%** | Stops an already-high account alerting on drift |

The volume gate is not caution for its own sake — it was derived from the
record. Across every observation in
[`data/scan-history.ndjson`](../data/scan-history.ndjson), only four accounts
have ever had a return at all, and an **ungated** rule fires three times:

- once on `aps.money`, which genuinely moved from 3.6% to 15% across 3,352
  inbound payments — the real signal
- **twice on an account whose "16.7% return rate" is one return out of six
  inbound payments** — which would be an alert naming a real business on the
  strength of a single event

25 is the same threshold the indexer already uses for `--min-inbound` and
Trust Check uses for its top confidence tier, rather than a number invented
for this rule.

A `refund.spike` payload therefore carries `inboundCount` alongside the rates,
so a consumer sees the sample the percentage rests on rather than reading a
percentage in isolation.

**If you are subscribing today, subscribe to `anchor.degraded`.** Migration
`010` made it the default and backfilled existing `anchor.dark` subscribers
onto it, on the reasoning that someone who asked to hear when an anchor stops
settling meant the event that happens, not the one that does not.

---

## Payload envelope

`Content-Type: application/json`

```json
{
  "event": "anchor.degraded",
  "account": "GABC…",
  "domain": "example-anchor.com",
  "previousState": "live",
  "currentState": "slow",
  "scanId": 4213,
  "occurredAt": "2026-09-08T12:23:20.818Z"
}
```

| Field | Meaning |
|---|---|
| `event` | One of the event types above |
| `account` | The Stellar account whose state changed |
| `domain` | The home domain the account is declared by (SEP-1) |
| `previousState` | State in the previous scan |
| `currentState` | State in the scan that triggered this |
| `scanId` | The scan that observed the change — joins to the published record |
| `occurredAt` | Server clock at dispatch, ISO 8601. **Not** the ledger time of the last settlement |

A `refund.spike` carries rate fields instead of state fields:

```json
{
  "event": "refund.spike",
  "account": "GABC…",
  "domain": "example-anchor.com",
  "previousRefundRate": 0.0362,
  "currentRefundRate": 0.1504,
  "inboundCount": 3352,
  "scanId": 4213,
  "occurredAt": "2026-09-08T12:23:20.818Z"
}
```

**A return is the honest failure mode.** An anchor that accepts value, fails
to settle and simply keeps it produces no return event at all — so a *rising*
refund rate is evidence of returns happening, not proof of misconduct, and a
low one is the absence of one kind of evidence rather than evidence of good
conduct.

`occurredAt` is when Landfall *noticed*, not when the anchor stopped. The
account's actual last activity is in the API (`hoursSinceActivity`), and the
gap between the two is bounded by the scan interval.

---

## Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Landfall-Event` | The event name, so you can route without parsing the body |
| `X-Landfall-Signature` | `sha256=<hex>` — HMAC-SHA256 of the **raw request body** using your subscription secret |

## Signature verification

Verify before trusting a payload. The signature is computed over the exact
bytes sent, so verify against the raw body — not a re-serialised object,
whose key order or whitespace may differ.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyLandfallSignature(rawBody, header, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header ?? "");
  // Length check first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Express, keeping the raw body intact:

```js
app.post("/landfall-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!verifyLandfallSignature(req.body, req.get("X-Landfall-Signature"), process.env.LANDFALL_WEBHOOK_SECRET)) {
      return res.sendStatus(401);
    }
    const event = JSON.parse(req.body.toString("utf8"));
    // …handle it…
    res.sendStatus(200);
  });
```

Use a constant-time comparison, as above. A plain `===` on an HMAC leaks
timing information about how much of the digest matched.

---

## Delivery, retries, and what "failed" means

| Property | Value |
|---|---|
| Method | `POST` |
| Attempts | **3** |
| Backoff | `0ms`, `1000ms`, `3000ms` — the first attempt is immediate |
| Per-attempt timeout | **5000ms** |
| Success | Any `2xx`. The first `2xx` stops retrying |
| Failure | Three attempts exhausted without a `2xx` |

Every delivery attempt is recorded in `webhook_deliveries` with its status,
attempt count, and last response status.

### Dead-letter replay

Four seconds is a narrow window, so a failed delivery is not the end. Since
migration `014` the failed row stores the payload that was sent, and
`scripts/redeliver-webhooks.mjs` runs after every hourly scan to retry it.

| Property | Value |
|---|---|
| Retry cadence | Once per hour, after each scan |
| Attempts per run | **1** — this is already the retry; a nested loop would herd a recovering endpoint |
| Window | **48 hours** from the original failure |
| Batch cap | 100 per run |
| Extra header | `X-Landfall-Redelivery: true`, so an idempotent handler can skip work it already did |

Three properties worth relying on:

- **The original event is resent verbatim, never rebuilt.** The account may
  have changed state again since; delivering current state under the original
  `occurredAt` would replace one inaccuracy with another.
- **The original failure row is never rewritten.** A replay is a new row whose
  `replay_of` points at it, so "failed, then succeeded on replay" stays two
  legible facts.
- **A success retires it; a failure does not.** Only a delivered replay stops
  further attempts, so an endpoint that recovers on hour nine still gets the
  event. After 48 hours it stops for good.

**It is still not a guaranteed log.** Past the window, or for rows written
before migration 014, a missed event is gone:

- **Reconcile against the API.** `GET /api/v1/anchors` carries current state
  for every account with `asOf`/`staleHours`, and it is authoritative.
- Missed deliveries are visible in `webhook_deliveries` with portal access,
  so a gap is diagnosable rather than invisible.

## Target URL restrictions

Target URLs are checked with `api/_lib/net-guard.js` before every delivery.
Private, loopback, link-local and IPv6 unique-local addresses are refused —
including IPv4-mapped IPv6 forms that wrap a blocked address. A webhook that
can be pointed at `169.254.169.254` is an SSRF primitive with a subscription
form in front of it.

A target that fails this check is skipped with a logged reason, and the
subscription is left alone rather than silently deactivated.

---

## Subscription management

Subscriptions live in `user_webhooks` and are managed from `/portal.html`
under a portal account.

| Column | Meaning |
|---|---|
| `target_url` | Where to POST. Subject to the guard above |
| `events` | Array of event names. Default `{"anchor.dark","anchor.degraded"}` |
| `secret` | Your HMAC secret. Shown once at creation |
| `active` | Inactive subscriptions are skipped, not deleted |

Rotating the secret invalidates signatures computed with the old one
immediately — there is no overlap window, so update your verifier in the same
change. See [KEY_ROTATION.md](KEY_ROTATION.md).

---

## When dispatch does not run

The dispatcher exits cleanly, with a log line rather than silence, when:

- `DATABASE_URL` is unset — no database, nothing to diff
- Fewer than two finished scans exist — a diff needs a previous state

Both are normal on a fresh deployment. Neither is an error, and neither is
hidden: this repo's rule is that a skipped step prints why.

---

## Related

- [`scripts/dispatch-webhooks.mjs`](../scripts/dispatch-webhooks.mjs) — the implementation
- [`packages/db/migrations/010_webhook_degraded_event.sql`](../packages/db/migrations/010_webhook_degraded_event.sql) — why `anchor.degraded` exists
- [API_REFERENCE.md](API_REFERENCE.md) — the polling path you should reconcile against
