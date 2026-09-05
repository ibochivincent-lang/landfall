import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkAccountsAttributed,
  checkCoverage,
  checkNoDuplicateRows,
  checkScanDelta,
  checkSharedAccounts,
  hasBlockingFinding,
  renderFindings,
  runInvariants,
  type CheckableAccount,
} from "../src/invariants.js";

/** The real account at the centre of the defect these checks exist for:
 *  Circle's USDC issuer, home_domain circle.com, cited by more than one
 *  anchor's stellar.toml and read as each of their own. */
const CIRCLE_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function acct(partial: Partial<CheckableAccount> & { account: string; domain: string }): CheckableAccount {
  return { inbound: 0, outbound: 0, ...partial };
}

/* ------------------------------------------------------------------ *
 * Attribution
 * ------------------------------------------------------------------ */

test("REGRESSION: one account claimed by two anchors is an error", () => {
  // Exactly the shape the live site published: the same Circle issuer account
  // attributed to two unrelated anchors, each row internally plausible.
  const findings = checkSharedAccounts([
    acct({ account: CIRCLE_ISSUER, domain: "stellar.moneygram.com", inbound: 497 }),
    acct({ account: CIRCLE_ISSUER, domain: "finclusive.com", inbound: 497 }),
    acct({ account: "GAWODAROMJ33V5YDFY3NPYTHVYQG7MJXVJ2ND3AOGIHYRWINES6ACCPD", domain: "cowrie.exchange" }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "error");
  assert.equal(findings[0]?.code, "shared-account");
  assert.match(findings[0]!.message, /claimed by 2 different anchors/);
  // The evidence has to name both claimants — a finding that says "something
  // is wrong" without saying who is not actionable.
  assert.match(findings[0]!.detail ?? "", /finclusive\.com/);
  assert.match(findings[0]!.detail ?? "", /stellar\.moneygram\.com/);
});

test("an account claimed by a single anchor is fine", () => {
  assert.deepEqual(
    checkSharedAccounts([
      acct({ account: "GA", domain: "a.com" }),
      acct({ account: "GB", domain: "a.com" }),
      acct({ account: "GC", domain: "b.com" }),
    ]),
    [],
  );
});

test("an account with no domain is an error, not a silently orphaned row", () => {
  const findings = checkAccountsAttributed([
    acct({ account: "GA", domain: "a.com" }),
    acct({ account: "GB", domain: "" }),
    acct({ account: "GC", domain: "   " }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "error");
  assert.match(findings[0]!.detail ?? "", /GB/);
  assert.match(findings[0]!.detail ?? "", /GC/);
});

test("the same account twice under one anchor double-counts and is rejected", () => {
  const findings = checkNoDuplicateRows([
    acct({ account: "GA", domain: "a.com" }),
    acct({ account: "GA", domain: "a.com" }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "duplicate-row");
});

test("the same account under two anchors is not reported as a duplicate row", () => {
  // It is a shared-account error instead; reporting it twice under two codes
  // would make one defect look like two.
  assert.deepEqual(
    checkNoDuplicateRows([
      acct({ account: "GA", domain: "a.com" }),
      acct({ account: "GA", domain: "b.com" }),
    ]),
    [],
  );
});

/* ------------------------------------------------------------------ *
 * Movement
 * ------------------------------------------------------------------ */

test("REGRESSION: an account suddenly resolving to a far busier one is an error", () => {
  // The signature of a misattribution appearing: a modest account replaced by
  // a global issuer's traffic between two consecutive scans.
  const findings = checkScanDelta(
    [acct({ account: "GA", domain: "anchor.com", inbound: 497, outbound: 3 })],
    [acct({ account: "GA", domain: "anchor.com", inbound: 12, outbound: 4 })],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "error");
  assert.equal(findings[0]?.code, "implausible-growth");
});

test("ordinary hour-to-hour growth is not flagged", () => {
  assert.deepEqual(
    checkScanDelta(
      [acct({ account: "GA", domain: "anchor.com", inbound: 210, outbound: 190 })],
      [acct({ account: "GA", domain: "anchor.com", inbound: 205, outbound: 188 })],
    ),
    [],
  );
});

test("a large ratio on tiny numbers is not flagged", () => {
  // 1 payment to 30 is 30x and means nothing. Ratio alone would cry wolf on
  // every newly-active account, which is why an absolute floor exists.
  assert.deepEqual(
    checkScanDelta(
      [acct({ account: "GA", domain: "anchor.com", inbound: 30 })],
      [acct({ account: "GA", domain: "anchor.com", inbound: 1 })],
    ),
    [],
  );
});

test("a collapse in published counts is an error, not a quiet anchor", () => {
  const findings = checkScanDelta(
    [acct({ account: "GA", domain: "anchor.com", inbound: 4, outbound: 1 })],
    [acct({ account: "GA", domain: "anchor.com", inbound: 300, outbound: 100 })],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "implausible-shrink");
});

test("window churn on a capped account is tolerated", () => {
  // This scan re-pages the most recent N payments rather than accumulating, so
  // the inbound/outbound split of a capped account drifts legitimately.
  assert.deepEqual(
    checkScanDelta(
      [acct({ account: "GA", domain: "anchor.com", inbound: 480, outbound: 20 })],
      [acct({ account: "GA", domain: "anchor.com", inbound: 495, outbound: 5 })],
    ),
    [],
  );
});

test("accounts absent from either scan are left to the coverage check", () => {
  assert.deepEqual(
    checkScanDelta(
      [acct({ account: "GNEW", domain: "anchor.com", inbound: 900 })],
      [acct({ account: "GOLD", domain: "anchor.com", inbound: 3 })],
    ),
    [],
  );
});

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

test("losing an anchor warns rather than blocking", () => {
  // Dropping MoneyGram was the correct outcome of fixing the defect. An
  // hourly job that refused to publish anything afterwards would have traded
  // a visible, correct change for permanent silence.
  const findings = checkCoverage(
    [acct({ account: "GA", domain: "a.com" })],
    [acct({ account: "GA", domain: "a.com" }), acct({ account: "GB", domain: "b.com" })],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "warning");
  assert.equal(findings[0]?.code, "coverage-loss");
  assert.match(findings[0]!.detail ?? "", /b\.com/);
  assert.equal(hasBlockingFinding(findings), false);
});

test("losing one account while its anchor stays covered is warned about separately", () => {
  const findings = checkCoverage(
    [acct({ account: "GA", domain: "a.com" })],
    [acct({ account: "GA", domain: "a.com" }), acct({ account: "GB", domain: "a.com" })],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "account-dropped");
  assert.match(findings[0]!.detail ?? "", /a\.com:GB/);
});

test("stable coverage produces nothing", () => {
  const set = [acct({ account: "GA", domain: "a.com" }), acct({ account: "GB", domain: "b.com" })];
  assert.deepEqual(checkCoverage(set, set), []);
});

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

test("a first run with no previous scan checks attribution but skips movement", () => {
  const findings = runInvariants({
    current: [acct({ account: "GA", domain: "a.com", inbound: 5000 })],
  });
  assert.deepEqual(findings, []);
});

test("runInvariants surfaces errors before warnings", () => {
  const findings = runInvariants({
    current: [
      acct({ account: CIRCLE_ISSUER, domain: "one.com" }),
      acct({ account: CIRCLE_ISSUER, domain: "two.com" }),
    ],
    previous: [
      acct({ account: CIRCLE_ISSUER, domain: "one.com" }),
      acct({ account: "GB", domain: "gone.com" }),
      acct({ account: "GC", domain: "alsogone.com" }),
    ],
  });

  assert.ok(findings.length >= 2);
  assert.equal(findings[0]?.severity, "error");
  assert.equal(findings.at(-1)?.severity, "warning");
  assert.equal(hasBlockingFinding(findings), true);
});

test("a clean scan blocks nothing and says so", () => {
  const set = [acct({ account: "GA", domain: "a.com", inbound: 10 })];
  const findings = runInvariants({ current: set, previous: set });
  assert.deepEqual(findings, []);
  assert.equal(hasBlockingFinding(findings), false);
  assert.equal(renderFindings(findings), "All invariants held.");
});

test("rendered output names the blocked publication when an error is present", () => {
  const rendered = renderFindings([
    { severity: "error", code: "shared-account", message: "m", detail: "d" },
    { severity: "warning", code: "coverage-loss", message: "m2" },
  ]);
  assert.match(rendered, /ERROR/);
  assert.match(rendered, /WARN/);
  assert.match(rendered, /1 error\(s\), 1 warning\(s\)/);
  assert.match(rendered, /Publication blocked/);
});
