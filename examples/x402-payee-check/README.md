# Check who you're about to pay, before you sign

x402 settles **how much** an agent may spend. It leaves open **who an agent
should be willing to pay.**

A 402 response hands your agent an `accepts` array of payment options. Nothing
in the protocol says whether the address in `payTo` has ever settled anything.
A human falls back on brand recognition, or having used the service before. An
agent has a domain string and whatever that domain says about itself — which
is the one input that can be edited in ten seconds.

This example asks the Stellar ledger instead.

## Run it

No dependencies, no API key, no install. Node 18+:

```bash
node check-before-paying.mjs
```

Against your own 402 response, passing the `PAYMENT-REQUIRED` header value:

```bash
node check-before-paying.mjs "eyJ4NDAyVmVyc2lvbiI6MSwi..."
```

## What it does

1. Decodes a real `PAYMENT-REQUIRED` header into x402's `PaymentRequired`
2. Sends the `accepts` array to `POST /api/v1/x402/check-payee`
3. Applies a spending policy to what comes back
4. **Stops at the decision** and hands the chosen option to your x402 client

Step 4 is the point. Landfall holds no keys and moves no money. It tells you
who has actually settled payments before; your own client does the paying.
Nothing in this example can spend anything.

## What you get back

Each entry in `accepts` gets exactly one assessment, in order. A payee is
either checkable or it is not, and the reason is always stated:

```jsonc
{
  "results": [
    {
      "requirement": { "network": "stellar:pubnet", "payTo": "GA5ZSEJ...", "amount": "10000" },
      "supported": true,
      "trustCheck": {
        "riskLevel": "low",
        "riskScore": 100,
        "confidence": "high",
        "paymentCount": 200,
        "flags": [ { "id": "high-concentration", "severity": "info", "summary": "..." } ],
        "recommendation": "No concerning patterns observed in this account's ledger history."
      }
    },
    {
      "requirement": { "network": "eip155:8453", "payTo": "0x1234..." },
      "supported": false,
      "reason": "network \"eip155:8453\" is not Stellar — Trust Check reads Stellar ledger history only."
    }
  ]
}
```

`supported: false` comes with `retryable` when the check failed rather than
being structurally impossible. The distinction matters: **"this account does
not exist on the ledger"** is a finding and a good reason not to pay, while
**"Horizon was unreachable"** is a temporary failure and a reason to try
again. Collapsing them would let an outage read like a clean bill of health,
or an empty address read like a network blip.

## The policy is yours

Landfall reports evidence and confidence. What counts as acceptable is the
spender's decision, so `decide()` in the script is the part you edit.

Two defaults there are worth keeping:

- **Unverifiable means refuse.** "Landfall cannot check this" is not "this is
  fine." A policy that treats an unanswerable question as a pass hands an
  attacker an obvious lever — pay to a contract address and get waved through.
- **Evidence gates the set; price only breaks ties inside it.** The example
  picks the cheapest option *among those that passed*. Letting price outrank
  evidence inverts the whole reason for checking.

## What this does not do

It does not verify or settle a payment. That is a facilitator's job — Stellar
has one, built by the SDF with OpenZeppelin, with audited spending-limit
contracts. Building a second one here would mean holding or routing funds
during settlement, which this project does not do anywhere.

It also only answers for classic Stellar accounts (`G...`) on
`stellar:pubnet` or `stellar:testnet`. Other chains, Soroban contract
addresses and muxed accounts come back `supported: false` with the reason
stated, rather than being quietly dropped from the list — a payee that
silently vanished from the results would be the most dangerous possible
output.

## See also

- [`packages/x402`](../../packages/x402) — the evaluator, and why it is shaped this way
- [`/trust-check.html`](https://landfall-chi.vercel.app/trust-check.html) — the same signals, for a human
- [`docs/MCP.md`](../../docs/MCP.md) — `landfall_x402_check_payee`, the same check as an MCP tool
