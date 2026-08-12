import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { toStroops, fromStroops, median, detectRefunds, computeMetrics } from "../src/metrics.js";
import { parseStellarToml } from "../src/toml.js";
import { normalise, assetId } from "../src/horizon.js";
import type { AnchorAccount, PaymentRecord, ScanOptions } from "../src/types.js";

const ANCHOR = "GANCHORANCHORANCHORANCHORANCHORANCHORANCHORANCHORANCHOR1";
const USER_A = "GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const USER_B = "GUSERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const USDC = "USDC:GISSUER";

let seq = 0;
function payment(
  from: string,
  to: string,
  amount: string,
  createdAt: string,
  asset = USDC,
): PaymentRecord {
  seq += 1;
  return {
    cursor: `c${seq}`,
    type: "payment",
    txHash: `tx${seq}`,
    from,
    to,
    amount,
    asset,
    createdAt,
  };
}

const OPTS: ScanOptions = {
  horizon: "https://example.invalid",
  maxRecords: 1000,
  refundWindowHours: 24 * 30,
  refundTolerance: 0.02,
};

const ANCHOR_META: AnchorAccount = { domain: "example.com", account: ANCHOR, role: "declared" };

/* -------------------------------------------------------------- */

test("toStroops and fromStroops round-trip without float drift", () => {
  assert.equal(toStroops("1"), 10_000_000n);
  assert.equal(toStroops("0.0000001"), 1n);
  assert.equal(toStroops("123.4567891"), 1_234_567_891n);
  assert.equal(fromStroops(10_000_000n), "1");
  assert.equal(fromStroops(1n), "0.0000001");
  assert.equal(fromStroops(1_234_567_891n), "123.4567891");
});

test("toStroops sums large volumes exactly where floats would drift", () => {
  // 0.1 + 0.2 !== 0.3 in float; in stroops it is exact.
  const sum = toStroops("0.1") + toStroops("0.2");
  assert.equal(fromStroops(sum), "0.3");
});

test("toStroops rejects junk without throwing", () => {
  assert.equal(toStroops("abc"), 0n);
  assert.equal(toStroops(""), 0n);
});

test("median handles even and odd lengths", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

/* -------------------------------------------------------------- */

test("parseStellarToml extracts declared accounts and currency issuers, deduped", () => {
  const text = readFileSync(new URL("../fixtures/anchor.toml", import.meta.url), "utf8");
  const parsed = parseStellarToml(text);

  assert.equal(parsed.name, "Example Anchor Ltd");
  assert.equal(parsed.accounts.length, 2);
  assert.ok(parsed.accounts.includes("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
  // The NGNC issuer is a distinct account and must be picked up.
  assert.ok(parsed.issuers.includes("GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"));
});

/* -------------------------------------------------------------- */

test("assetId canonicalises native and credit assets", () => {
  assert.equal(assetId({ asset_type: "native" }), "native");
  assert.equal(
    assetId({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GISSUER" }),
    "USDC:GISSUER",
  );
});

test("normalise maps create_account into a payment shape", () => {
  const rec = normalise({
    type: "create_account",
    paging_token: "1",
    transaction_hash: "h",
    funder: ANCHOR,
    account: USER_A,
    starting_balance: "2.5",
    created_at: "2026-01-01T00:00:00Z",
  });
  assert.ok(rec);
  assert.equal(rec.from, ANCHOR);
  assert.equal(rec.to, USER_A);
  assert.equal(rec.asset, "native");
  assert.equal(rec.amount, "2.5");
});

test("normalise returns null for records with no attributable transfer", () => {
  assert.equal(normalise({ type: "change_trust", paging_token: "1" }), null);
});

/* -------------------------------------------------------------- */

test("detectRefunds matches a returned withdrawal", () => {
  const records = [
    payment(USER_A, ANCHOR, "100", "2026-01-01T00:00:00Z"),
    payment(ANCHOR, USER_A, "99.5", "2026-01-01T06:00:00Z"), // returned, 0.5% fee
  ];
  const pairs = detectRefunds(ANCHOR, records, OPTS);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.counterparty, USER_A);
  assert.equal(pairs[0]?.latencyHours, 6);
});

test("detectRefunds ignores a payout that is not a return of a prior inbound", () => {
  const records = [
    payment(ANCHOR, USER_A, "100", "2026-01-01T00:00:00Z"), // deposit fulfilment, nothing came in first
  ];
  assert.equal(detectRefunds(ANCHOR, records, OPTS).length, 0);
});

test("detectRefunds respects the amount tolerance", () => {
  const records = [
    payment(USER_A, ANCHOR, "100", "2026-01-01T00:00:00Z"),
    payment(ANCHOR, USER_A, "50", "2026-01-01T01:00:00Z"), // half back — not a full return
  ];
  assert.equal(detectRefunds(ANCHOR, records, OPTS).length, 0);
});

test("detectRefunds respects the time window", () => {
  const records = [
    payment(USER_A, ANCHOR, "100", "2026-01-01T00:00:00Z"),
    payment(ANCHOR, USER_A, "100", "2026-06-01T00:00:00Z"), // five months later
  ];
  assert.equal(detectRefunds(ANCHOR, records, OPTS).length, 0);
});

test("detectRefunds will not consume one inbound twice", () => {
  const records = [
    payment(USER_A, ANCHOR, "100", "2026-01-01T00:00:00Z"),
    payment(ANCHOR, USER_A, "100", "2026-01-01T01:00:00Z"),
    payment(ANCHOR, USER_A, "100", "2026-01-01T02:00:00Z"),
  ];
  // Only one inbound exists, so at most one return can be attributed.
  assert.equal(detectRefunds(ANCHOR, records, OPTS).length, 1);
});

test("detectRefunds does not cross assets", () => {
  const records = [
    payment(USER_A, ANCHOR, "100", "2026-01-01T00:00:00Z", "USDC:GISSUER"),
    payment(ANCHOR, USER_A, "100", "2026-01-01T01:00:00Z", "EURC:GISSUER"),
  ];
  assert.equal(detectRefunds(ANCHOR, records, OPTS).length, 0);
});

/* -------------------------------------------------------------- */

test("computeMetrics separates inbound from outbound and rates refunds", () => {
  const records = [
    payment(USER_A, ANCHOR, "100", "2026-01-01T00:00:00Z"),
    payment(USER_B, ANCHOR, "300", "2026-01-01T00:00:00Z"),
    payment(ANCHOR, USER_A, "100", "2026-01-01T05:00:00Z"), // return to A
    payment(ANCHOR, USER_B, "42", "2026-01-02T00:00:00Z"), // unrelated payout
  ];

  const now = new Date("2026-01-03T00:00:00Z");
  const m = computeMetrics(ANCHOR_META, records, OPTS, now);

  assert.equal(m.inbound.count, 2);
  assert.equal(m.outbound.count, 2);
  assert.equal(m.inbound.uniqueCounterparties, 2);
  assert.equal(m.refundCount, 1);
  assert.equal(m.refundRate, 0.5);
  assert.equal(m.medianRefundLatencyHours, 5);

  // 400 total inbound, largest single sender contributed 300.
  assert.equal(m.topCounterpartyShare, 0.75);

  // Newest record is 2026-01-02T00:00:00Z, now is 24h later.
  assert.equal(m.hoursSinceLastActivity, 24);
  assert.equal(m.inbound.byAsset[0]?.volume, "400");
});

test("computeMetrics reports null rates rather than dividing by zero", () => {
  const m = computeMetrics(ANCHOR_META, [], OPTS, new Date("2026-01-01T00:00:00Z"));
  assert.equal(m.refundRate, null);
  assert.equal(m.medianRefundLatencyHours, null);
  assert.equal(m.topCounterpartyShare, null);
  assert.equal(m.sampled, 0);
  assert.equal(m.hoursSinceLastActivity, undefined);
});

test("computeMetrics excludes self-payments from both directions", () => {
  const records = [payment(ANCHOR, ANCHOR, "10", "2026-01-01T00:00:00Z")];
  const m = computeMetrics(ANCHOR_META, records, OPTS, new Date("2026-01-02T00:00:00Z"));
  assert.equal(m.inbound.count, 0);
  assert.equal(m.outbound.count, 0);
  assert.equal(m.sampled, 1);
});
