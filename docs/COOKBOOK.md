# Cookbook

Working recipes, shortest first. Every one was executed before it was written
down — where a recipe hits the network, the output shown is what it actually
returned.

No API key is needed for any read. See [API_REFERENCE.md](API_REFERENCE.md)
for limits.

---

## 1. Check an address before paying it

The single most useful call. No key, no database, no SDK — it reads Horizon
live, so it stays up when the rest of Landfall does not.

```bash
curl -s "https://landfall-chi.vercel.app/api/v1/trust-check?address=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" \
  | jq '{riskLevel, riskScore, confidence, paymentCount, flags: [.flags[].id]}'
```

```json
{
  "riskLevel": "low",
  "riskScore": 100,
  "confidence": "high",
  "paymentCount": 200,
  "flags": ["high-concentration"]
}
```

**Read `confidence` before `riskScore`.** If it is `low`, `riskLevel` returns
`unknown` regardless of the arithmetic — a score computed from three payments
is noise, not a finding.

A `flag` is a ledger fact, not an accusation. `high-concentration` at `info`
severity is common and often benign: a wallet paying one merchant repeatedly
looks identical to a funnel.

---

## 2. Decide whether to pay, in code

The policy is yours; Landfall reports evidence. What matters is the
`catch`:

```js
async function safeToPay(address) {
  const res = await fetch(
    `https://landfall-chi.vercel.app/api/v1/trust-check?address=${address}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`Landfall returned ${res.status}`);

  const check = await res.json();
  if (check.confidence === "low") return { pay: false, why: "too little history to judge" };
  if (check.riskLevel !== "low")   return { pay: false, why: `risk level ${check.riskLevel}` };
  return { pay: true, why: check.recommendation };
}

// An unreachable Landfall means UNKNOWN, never a pass.
try {
  const verdict = await safeToPay(addr);
} catch {
  // Do not fall through to paying.
}
```

A `502` from Landfall means Horizon was unreachable. It says nothing about
the address, and treating it as a pass gives an attacker an easy lever.

---

## 3. Check who an agent is about to pay (x402)

Hand the `accepts` array straight from a 402 response:

```bash
curl -s -X POST https://landfall-chi.vercel.app/api/v1/x402/check-payee \
  -H "Content-Type: application/json" \
  -d '{"accepts":[
        {"scheme":"exact","network":"stellar:pubnet","asset":"CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
         "amount":"10000","payTo":"GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
         "maxTimeoutSeconds":60,"extra":{}},
        {"scheme":"exact","network":"eip155:8453","asset":"0x0",
         "amount":"10000","payTo":"0xabc","maxTimeoutSeconds":60,"extra":{}}]}' \
  | jq '[.results[] | {network: .requirement.network, supported, reason}]'
```

```json
[
  { "network": "stellar:pubnet", "supported": true,  "reason": null },
  { "network": "eip155:8453",    "supported": false,
    "reason": "network \"eip155:8453\" is not Stellar — Trust Check reads Stellar ledger history only." }
]
```

One assessment per requirement, **in input order**, and one bad payee never
removes another's answer. `supported: false` carries `retryable` so a
transient Horizon outage cannot read the same as "that account does not
exist" — the most damning thing this check can find.

A full worked client is in
[`examples/x402-payee-check`](../examples/x402-payee-check).

---

## 4. Rank anchors by evidence, not price

```bash
npm install @landfall/sdk
```

```js
import { pickAnchor, summarizeTiers } from "@landfall/sdk";

const ranked = pickAnchor([
  { anchorId: "alpha.example", summary: {
      anchorId: "alpha.example", tiers: summarizeTiers(nineHundredDerivedEvents),
      chains: [], totalEvents: 900, tierMix: "PROVEN 0 · ATTESTED 0 · DERIVED 900" } },
  { anchorId: "beta.example",  summary: {
      anchorId: "beta.example",  tiers: summarizeTiers(twelveProvenEvents),
      chains: [], totalEvents: 12,  tierMix: "PROVEN 12 · ATTESTED 0 · DERIVED 0" } },
]);

ranked[0].anchorId;   // "beta.example"
ranked[0].rationale;  // "Ranked on 12 ledger-proven settlement(s)."
```

**12 `PROVEN` outranks 900 `DERIVED`.** Tiers are compared
lexicographically and never blended — the moment they collapse into one
weighted number, enough weak evidence buys a strong-looking position.

---

## 5. Verify the oracle digest yourself

The point of publishing a digest rather than a score is that you can check it
without trusting the publisher.

```bash
CONTRACT=$(cat .contract-id.testnet)
stellar contract invoke --id "$CONTRACT" --network testnet -- get_digest
stellar contract invoke --id "$CONTRACT" --network testnet -- get_epoch
```

Recompute the digest from the published dataset using the rule in
[CANONICAL_JSON.md](CANONICAL_JSON.md) — sort keys recursively, serialise with
no whitespace, UTF-8, SHA-256 — and compare.

**If they disagree, trust neither** until the disagreement is explained. That
is the failure mode the digest exists to make detectable.

`get_epoch` is how you notice a missed update: it increments once per
publication, so a counter that has not moved means either nothing new was
published or the publisher stopped. Cross-check `staleHours` from the API to
tell which.

---

## 6. Receive webhooks, and verify them

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(header ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post("/landfall", express.raw({ type: "application/json" }), (req, res) => {
  if (!verify(req.body, req.get("X-Landfall-Signature"), SECRET)) return res.sendStatus(401);

  const e = JSON.parse(req.body.toString("utf8"));
  if (e.event === "anchor.degraded") alert(`${e.domain}: ${e.previousState} → ${e.currentState}`);
  if (e.event === "refund.spike")    alert(`${e.domain}: refunds ${e.previousRefundRate} → ${e.currentRefundRate} over ${e.inboundCount} inbound`);

  res.sendStatus(200);   // 2xx stops the retries
});
```

Three things worth getting right:

- **Verify against the raw body.** The signature covers the exact bytes sent;
  a re-serialised object may differ in key order or whitespace.
- **Use a constant-time compare.** `===` on an HMAC leaks how much matched.
- **Subscribe to `anchor.degraded`, not `anchor.dark`.** Zero transitions
  *into* dark have ever been observed — every dark account was already dark
  when first seen. `anchor.degraded` is the event that actually fires.

`X-Landfall-Redelivery: true` marks a replay from the dead-letter queue, so an
idempotent handler can skip work it already did.

---

## 7. Reconcile, because webhooks are not a log

Webhooks are a latency optimisation over polling. Past the 48-hour replay
window a missed event is gone, so the API stays authoritative:

```bash
curl -s https://landfall-chi.vercel.app/api/v1/anchors \
  | jq '{asOf, staleHours, degraded: [.accounts[] | select(.state != "live") | {domain, state, hoursSinceActivity}]}'
```

Check `staleHours` before acting. The scan asks for hourly and GitHub
delivers a median 2.8 h gap — see [BENCHMARKS.md](BENCHMARKS.md).

---

## 8. Query from an AI agent

```json
{
  "mcpServers": {
    "landfall": {
      "command": "node",
      "args": ["/absolute/path/to/landfall/scripts/mcp/server.mjs"],
      "env": { "DATABASE_URL": "postgresql://..." }
    }
  }
}
```

11 read-only tools. Filing a fraud report and disputing one are deliberately
**not** exposed — an accusation an agent can make in one tool call is a
lower-friction path to a fabricated claim about a real party, and a dispute
needs a private key no tool should ever take as an argument. Reasoning in
[MCP.md](MCP.md).

---

## 9. Recompute a published figure from Horizon

The recipe that matters most, because it is the one that makes the rest
checkable. Nothing here needs Landfall's cooperation.

```bash
ACCOUNT=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# oldest retained payment — a LOWER BOUND on age, not a creation date
curl -s "https://horizon.stellar.org/accounts/$ACCOUNT/payments?order=asc&limit=1" \
  | jq -r '._embedded.records[0].created_at'

# the same window Trust Check reads
curl -s "https://horizon.stellar.org/accounts/$ACCOUNT/payments?order=desc&limit=200" \
  | jq '._embedded.records | length'
```

The arithmetic on top of that is in [methodology.md](methodology.md), and the
full observation history is committed at
[`data/scan-history.ndjson`](../data/scan-history.ndjson) so you can check a
trend rather than a snapshot.

**If you recompute a figure and get a different answer, that is the most
valuable issue this project can receive.** See
[TAKEDOWN.md](TAKEDOWN.md) for how corrections are handled.

---

## Related

- [API_REFERENCE.md](API_REFERENCE.md) · [WEBHOOKS.md](WEBHOOKS.md) · [MCP.md](MCP.md) · [ORACLE_SPEC.md](ORACLE_SPEC.md)
- [FAQ.md](FAQ.md) — what the fields do and do not mean
- [`examples/x402-payee-check`](../examples/x402-payee-check) — a full runnable client
