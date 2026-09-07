#!/usr/bin/env node
/**
 * x402: check who you're about to pay, before you sign.
 *
 * x402 settles *how much* an agent may spend. It leaves open *who an agent
 * should be willing to pay* — a 402 response hands you an `accepts` array of
 * payment options, and nothing in the protocol says whether the address in
 * `payTo` has ever settled anything. A human falls back on brand
 * recognition. An agent has a domain string and whatever that domain says
 * about itself, which is the one input that can be edited in ten seconds.
 *
 * This example closes that gap for Stellar payees. It:
 *
 *   1. decodes a real PAYMENT-REQUIRED header into x402's PaymentRequired
 *   2. asks Landfall what the public ledger shows about every `payTo` in it
 *   3. applies a spending policy to the answer
 *   4. STOPS at the decision, and hands the chosen option back to your
 *      x402 client to sign
 *
 * Step 4 is the point. Landfall holds no keys and moves no money — it tells
 * you who has actually settled payments before, and your own client does the
 * paying. Nothing here can spend anything.
 *
 * No dependencies, no API key, no install. Node 18+:
 *
 *   node check-before-paying.mjs
 *
 * Run it against your own 402 response:
 *
 *   node check-before-paying.mjs "<base64 PAYMENT-REQUIRED header value>"
 */

const LANDFALL = process.env.LANDFALL_API ?? 'https://landfall-chi.vercel.app';

/**
 * A sample 402 body, shaped exactly like x402-foundation/x402's
 * `PaymentRequired` type. Three options on purpose: one live Stellar anchor
 * account, one Stellar address with no settlement history, and one on Base —
 * so you can see all three answers Landfall gives.
 */
const SAMPLE_PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://api.example.com/v1/forecast', description: 'One forecast call' },
  accepts: [
    {
      scheme: 'exact',
      network: 'stellar:pubnet',
      asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', // USDC on Stellar
      amount: '10000',
      payTo: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      maxTimeoutSeconds: 60,
      extra: {},
    },
    {
      scheme: 'exact',
      network: 'stellar:pubnet',
      asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      amount: '9500', // cheaper — which is exactly why you check first
      payTo: 'GDOPEVQPMSYXQDRQFMBYPWFBTFXYQPXBTSCVMHQKFPFPRXHRPFPXTHIS',
      maxTimeoutSeconds: 60,
      extra: {},
    },
    {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      payTo: '0x1234567890123456789012345678901234567890',
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
};

/** x402 sends PaymentRequired as base64 JSON in the PAYMENT-REQUIRED header. */
function decodePaymentRequiredHeader(headerValue) {
  return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
}

/** Ask Landfall what the ledger shows about every payee in `accepts`. */
async function checkPayees(accepts) {
  const res = await fetch(`${LANDFALL}/api/v1/x402/check-payee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accepts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Landfall returned HTTP ${res.status}`);
  return (await res.json()).results;
}

/**
 * Your policy, not Landfall's. Landfall reports evidence and confidence; what
 * counts as acceptable is the spender's call, so this is the part you edit.
 *
 * Note what this does with an unsupported payee: it refuses rather than
 * assuming safety. "Landfall cannot check this" is not "this is fine" — and a
 * policy that treats an unanswerable question as a pass gives an attacker an
 * obvious lever (pay to a contract address, get waved through).
 */
function decide(result) {
  if (!result.supported) {
    return { pay: false, why: `unverifiable — ${result.reason}` };
  }

  const { riskLevel, riskScore, confidence, paymentCount } = result.trustCheck;

  if (confidence === 'low') {
    return { pay: false, why: `only ${paymentCount} payment(s) observed — too little history to judge` };
  }
  if (riskLevel === 'high' || riskLevel === 'unknown') {
    return { pay: false, why: `risk level "${riskLevel}" (score ${riskScore}/100)` };
  }
  if (riskLevel === 'medium') {
    return { pay: false, why: `risk level "medium" (score ${riskScore}/100) — tighten or loosen this line to taste` };
  }
  return { pay: true, why: `${riskLevel} risk, score ${riskScore}/100, ${confidence} confidence over ${paymentCount} payments` };
}

function short(addr) {
  return typeof addr === 'string' && addr.length > 18 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

async function main() {
  const headerArg = process.argv[2];
  const paymentRequired = headerArg
    ? decodePaymentRequiredHeader(headerArg)
    : SAMPLE_PAYMENT_REQUIRED;

  console.log(`\nResource: ${paymentRequired.resource?.url ?? '(unnamed)'}`);
  console.log(`${paymentRequired.accepts.length} payment option(s) offered.\n`);

  const results = await checkPayees(paymentRequired.accepts);

  const acceptable = [];
  results.forEach((result, i) => {
    const req = result.requirement;
    const verdict = decide(result);

    console.log(`[${i + 1}] ${req.amount} on ${req.network}`);
    console.log(`    payTo:  ${short(req.payTo)}`);
    console.log(`    ${verdict.pay ? 'ACCEPTABLE' : 'REFUSED'} — ${verdict.why}`);
    if (result.supported) {
      for (const flag of result.trustCheck.flags) {
        console.log(`      • [${flag.severity}] ${flag.summary}`);
      }
    }
    console.log();

    if (verdict.pay) acceptable.push({ req, result });
  });

  if (acceptable.length === 0) {
    console.log('No payment option passed the policy. Nothing to sign — this is a normal outcome,');
    console.log('not an error. Refusing to pay an unverifiable counterparty is the feature.\n');
    return;
  }

  // Cheapest among those that passed — evidence gates the set, price only
  // breaks ties inside it. Never let price outrank evidence: that inverts the
  // whole point of checking.
  acceptable.sort((a, b) => Number(a.req.amount) - Number(b.req.amount));
  const chosen = acceptable[0];

  console.log(`Chosen: ${chosen.req.amount} to ${short(chosen.req.payTo)} on ${chosen.req.network}`);
  console.log(`  ${acceptable.length} of ${results.length} option(s) passed; cheapest of those.\n`);
  console.log('Hand this requirement to your x402 client to sign and settle, e.g.:');
  console.log('  const payload = await client.createPayment(chosen);');
  console.log('  await fetch(resource, { headers: client.encodePaymentSignatureHeader(payload) });\n');
  console.log('Landfall stops here on purpose. It holds no keys and moves no money —');
  console.log('it answers who has actually settled before, and your client does the paying.\n');
}

main().catch((err) => {
  // A failed check must never read as approval. If you cannot find out who
  // you are paying, that is a reason not to pay, not a reason to continue.
  console.error(`\nCheck failed: ${err.message}`);
  console.error('Treat this as "unknown", not "safe" — do not fall through to paying.\n');
  process.exit(1);
});
