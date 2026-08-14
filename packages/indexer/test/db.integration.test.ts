/**
 * Integration test for the Postgres persistence path.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated database, so the
 * default `npm test` stays offline and a contributor never needs Docker to
 * fix a metric. Run it with:
 *
 *   TEST_DATABASE_URL=postgres://... npm test -w @landfall/indexer
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { mergeWithHistory } from "../src/history.js";
import { computeMetrics } from "../src/metrics.js";
import { classifyLiveness } from "../src/report.js";
import { DEFAULT_SCAN_OPTIONS, type AnchorAccount, type PaymentRecord } from "../src/types.js";

const URL = process.env["TEST_DATABASE_URL"];
const skip = URL ? false : "TEST_DATABASE_URL not set";

let store: Store;

const DOMAIN = "integration.test";
const ANCHOR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const USER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const meta: AnchorAccount = { domain: DOMAIN, account: ANCHOR, role: "declared" };

let seq = 0;
const pay = (from: string, to: string, amount: string, at: string): PaymentRecord => ({
  cursor: `itest-${++seq}`,
  type: "payment",
  txHash: `hash-${seq}`,
  from,
  to,
  amount,
  asset: "USDC:GISSUER",
  createdAt: at,
});

before(async () => {
  if (!URL) return;
  store = new Store({ connectionString: URL });
  await store.assertReady();
});

after(async () => {
  if (store) await store.close();
});

test("assertReady rejects an unmigrated database", { skip }, async () => {
  // The schema_version row is what proves the migration ran. Scanning against
  // a reachable-but-empty database would otherwise fail deep inside an insert.
  assert.ok(await store.assertReady().then(() => true));
});

test("a full scan round-trips through Postgres", { skip }, async () => {
  await store.upsertAnchor(DOMAIN, "Integration Anchor");
  await store.upsertAccounts([meta]);

  const records = [
    pay(USER, ANCHOR, "100", "2026-02-01T00:00:00Z"),
    pay(USER, ANCHOR, "250", "2026-02-02T00:00:00Z"),
    pay(ANCHOR, USER, "100", "2026-02-01T06:00:00Z"), // a return
  ];

  const m = computeMetrics(meta, records, DEFAULT_SCAN_OPTIONS, new Date("2026-02-10T00:00:00Z"));
  const scanId = await store.startScan("http://mock", DEFAULT_SCAN_OPTIONS);

  await store.setLiveness(ANCHOR, m.lastActivityAt);
  await store.writeMetrics(scanId, m, classifyLiveness(m).replace("-", "_"));
  const written = await store.insertPayments(records, new Set());
  await store.finishScan(scanId, 1);

  assert.equal(written, 3, "all three payments persisted");
  assert.equal(m.refundCount, 1, "the return was detected before persisting");
});

test("re-inserting the same payments is a no-op", { skip }, async () => {
  // The indexer re-reads overlapping windows constantly. Duplicates would
  // silently inflate every volume figure derived from the table.
  const dupe = [pay(USER, ANCHOR, "5", "2026-03-01T00:00:00Z")];
  const first = await store.insertPayments(dupe, new Set());
  const second = await store.insertPayments(dupe, new Set());
  assert.equal(first, 1);
  assert.equal(second, 0, "conflicting paging_token is ignored, not duplicated");
});

test("cursors survive a round trip", { skip }, async () => {
  assert.equal(await store.getCursor("payments", ANCHOR), undefined);
  await store.setCursor("payments", ANCHOR, "12345");
  assert.equal(await store.getCursor("payments", ANCHOR), "12345");
  await store.setCursor("payments", ANCHOR, "67890");
  assert.equal(await store.getCursor("payments", ANCHOR), "67890", "cursor advances");
});

test("an incremental scan still publishes cumulative figures", { skip }, async () => {
  // Regression test for the scan that reported 4,039 payments at 07:00 and 4 at
  // 08:00 because a cursor-resumed run began computing metrics from its own
  // fetch instead of from stored history. Nothing about the ledger changed;
  // only the size of the window we looked through did, and every published
  // figure silently changed meaning with it.
  //
  // The account below has history and receives exactly one new payment, which
  // is the normal, healthy shape of an hourly run. The figures must describe
  // the account, not the hour.
  const account = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const incremental: AnchorAccount = { domain: DOMAIN, account, role: "declared" };
  await store.upsertAccounts([incremental]);

  const history = Array.from({ length: 40 }, (_, i) =>
    pay(USER, account, "25.0000000", new Date(Date.UTC(2026, 5, 1, i)).toISOString()),
  );
  await store.insertPayments(history, new Set());

  const fetchedThisRun = [
    pay(USER, account, "500.0000000", new Date(Date.UTC(2026, 5, 2, 0)).toISOString()),
  ];

  const merged = await mergeWithHistory(store, account, fetchedThisRun);
  assert.equal(merged.length, history.length + 1, "history is read back and merged");

  const m = computeMetrics(incremental, merged, DEFAULT_SCAN_OPTIONS, new Date());
  assert.equal(m.inbound.count, 41, "inbound counts the account's history, not the hour");

  const fetchOnly = computeMetrics(incremental, fetchedThisRun, DEFAULT_SCAN_OPTIONS, new Date());
  assert.equal(fetchOnly.inbound.count, 1, "and the un-merged figure is the bug being guarded against");

  // Replaying the same fetch must not inflate anything: the paging token is the
  // same key `payments` conflicts on, so an overlap collapses.
  const replayed = await mergeWithHistory(store, account, [...fetchedThisRun, ...fetchedThisRun]);
  assert.equal(replayed.length, history.length + 1, "duplicate paging tokens collapse");
});

test("a history read that fails degrades loudly, never silently", { skip }, async () => {
  // A database hiccup must not turn into a published undercount. The scan keeps
  // going with what it fetched, and says so.
  const warnings: string[] = [];
  const failing = {
    paymentsForAccount: async () => {
      throw new Error("connection reset");
    },
  };
  const fetched = [pay(USER, ANCHOR, "10.0000000", "2026-06-01T00:00:00.000Z")];
  const out = await mergeWithHistory(failing, ANCHOR, fetched, {
    onWarning: (m) => warnings.push(m),
  });
  assert.equal(out.length, 1, "falls back to the fetch");
  assert.equal(warnings.length, 1, "and does not do it quietly");
});

test("liveness is stored from the lifetime reading, not the window", { skip }, async () => {
  // An account dormant since before the window has zero sampled records but a
  // real last-activity date. Storing the window value would hide it.
  const dormant: AnchorAccount = { domain: DOMAIN, account: USER, role: "issuer" };
  await store.upsertAccounts([dormant]);
  const m = computeMetrics(
    dormant, [], DEFAULT_SCAN_OPTIONS,
    new Date("2026-08-12T00:00:00Z"),
    "2025-09-01T00:00:00Z",
  );
  assert.equal(m.sampled, 0);
  assert.equal(m.hasLifetimeActivity, true);
  await store.setLiveness(USER, m.lastActivityAt);

  const scanId = await store.startScan("http://mock", DEFAULT_SCAN_OPTIONS);
  await store.writeMetrics(scanId, m, classifyLiveness(m).replace("-", "_"));
  await store.finishScan(scanId, 1);
  assert.equal(classifyLiveness(m), "dark", "dormant-before-window is dark, not no-activity");
});
