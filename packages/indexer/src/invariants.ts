/**
 * Invariants — checks that must hold for a scan to be publishable.
 *
 * This module exists because of a specific failure. For an unknown length of
 * time the published site credited Circle's shared USDC issuer account
 * (GA5ZSEJY…KZVN, home_domain circle.com) to `stellar.moneygram.com`, because
 * MoneyGram's stellar.toml cites that issuer — correctly, per SEP-1 — in its
 * [[CURRENCIES]] block, and the discovery code treated every cited issuer as
 * an account belonging to the citing domain. Global USDC issuance traffic was
 * therefore reported as one named business's settlement record. The same
 * account was simultaneously attributed to a second anchor, which is what
 * finally exposed it.
 *
 * The bug was found by luck, while adding an unrelated anchor. Nothing in a
 * suite of passing tests had an opinion about it, because every test asked
 * "does this function return what it should" and none asked "is the published
 * set of claims internally coherent". These checks ask the second question.
 *
 * Severity split, and the reasoning behind it:
 *
 *   error   — blocks publication. Reserved for claims that are *invisibly*
 *             wrong: a reader cannot tell a misattributed account from a
 *             correct one by looking at the site, so shipping it launders a
 *             defect into something that reads as a measurement.
 *   warning — published, but shouted. Used where the change is real, large,
 *             and self-evident on the site itself (an anchor disappearing,
 *             say). A human should look, but withholding the whole update
 *             would trade a visible change for a silent staleness — and an
 *             unattended hourly job that blocks on legitimate change stops
 *             publishing entirely the first time the world moves.
 *
 * The project's stated rule is that degradation must be stale rather than
 * wrong. These checks are how that rule is enforced rather than asserted.
 */

/** How much a finding should stop the pipeline. */
export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  /** Stable machine-readable id, for grepping logs across runs. */
  code: string;
  message: string;
  /** Evidence: the accounts, domains or numbers the claim rests on. */
  detail?: string;
}

/** The minimum shape these checks need — deliberately not AccountMetrics, so
 *  the published API rows (which are a narrower projection) can be checked
 *  with the same code that checks a raw scan. */
export interface CheckableAccount {
  account: string;
  domain: string;
  inbound?: number;
  outbound?: number;
}

export interface DeltaThresholds {
  /** Relative growth beyond which an increase is treated as implausible. */
  maxGrowthFactor: number;
  /** Increases smaller than this many payments are never flagged, however
   *  large the ratio — going from 1 payment to 30 is 30x and means nothing. */
  minAbsoluteGrowth: number;
  /** Relative shrink beyond which a decrease is treated as implausible. */
  maxShrinkFraction: number;
  /** Decreases smaller than this many payments are never flagged. */
  minAbsoluteShrink: number;
  /** Fraction of domains that may disappear before it is worth shouting. */
  maxDomainLossFraction: number;
}

/**
 * Defaults tuned against the real failure mode rather than to taste.
 *
 * The growth thresholds are set where they are because the Circle issuer
 * arrived as ~500 inbound payments on an account previously reporting a
 * couple of hundred at most, and because a genuine anchor cannot multiply its
 * lifetime settlement count several-fold inside one hour. The shrink
 * thresholds are looser than they look: this scan re-pages the most recent
 * `--max-records` payments each run rather than accumulating, so for an
 * account pinned at that ceiling the inbound/outbound split legitimately
 * drifts as new payments push old ones out of the window. Only a collapse
 * well beyond that churn is treated as data loss.
 */
export const DEFAULT_THRESHOLDS: DeltaThresholds = {
  maxGrowthFactor: 10,
  minAbsoluteGrowth: 100,
  maxShrinkFraction: 0.5,
  minAbsoluteShrink: 20,
  maxDomainLossFraction: 0.25,
};

/* ------------------------------------------------------------------ *
 * Attribution
 * ------------------------------------------------------------------ */

/**
 * No on-chain account may be claimed by more than one anchor.
 *
 * This is the check that would have caught the MoneyGram defect on the first
 * scan after it appeared. A Stellar account has exactly one operator; if two
 * home domains both declare it, at least one of those claims is false, and
 * there is no way to tell which from the ledger alone. Both are therefore
 * unpublishable — crediting settlement to the wrong business is the one error
 * an evidence tier cannot catch, because it happens before evidence is
 * attributed to anyone.
 */
export function checkSharedAccounts(accounts: CheckableAccount[]): Finding[] {
  const domainsByAccount = new Map<string, Set<string>>();
  for (const row of accounts) {
    if (!domainsByAccount.has(row.account)) domainsByAccount.set(row.account, new Set());
    domainsByAccount.get(row.account)!.add(row.domain);
  }

  const findings: Finding[] = [];
  for (const [account, domains] of domainsByAccount) {
    if (domains.size < 2) continue;
    findings.push({
      severity: "error",
      code: "shared-account",
      message: `Account ${account} is claimed by ${domains.size} different anchors — at most one of those claims can be true.`,
      detail: `Claimed by: ${[...domains].sort().join(", ")}. A shared account is usually a third party's (a stablecoin issuer cited in [[CURRENCIES]], say) being read as the citing domain's own.`,
    });
  }
  return findings;
}

/**
 * Every published row must name the anchor it belongs to.
 *
 * An unattributed row still contributes to the dark/live census and to the
 * totals on the front page, so it changes published claims while belonging to
 * nobody a reader could go and check.
 */
export function checkAccountsAttributed(accounts: CheckableAccount[]): Finding[] {
  const orphans = accounts.filter((a) => !a.domain || !a.domain.trim());
  if (orphans.length === 0) return [];
  return [
    {
      severity: "error",
      code: "unattributed-account",
      message: `${orphans.length} account(s) have no anchor domain, but still count toward published totals.`,
      detail: orphans.map((a) => a.account).join(", "),
    },
  ];
}

/**
 * The same account must not appear twice in one published set.
 *
 * Duplicate rows double-count in every aggregate on the site — the account
 * census, the dark ratio, the inbound total — while each individual row still
 * looks correct.
 */
export function checkNoDuplicateRows(accounts: CheckableAccount[]): Finding[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const row of accounts) {
    const key = `${row.domain}:${row.account}`;
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  if (dupes.size === 0) return [];
  return [
    {
      severity: "error",
      code: "duplicate-row",
      message: `${dupes.size} account row(s) appear more than once, double-counting in every published total.`,
      detail: [...dupes].join(", "),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Movement against the last published scan
 * ------------------------------------------------------------------ */

/**
 * Per-account payment counts must not move implausibly between scans.
 *
 * A misattribution does not announce itself as an error; it announces itself
 * as a number that suddenly got much bigger. Comparing each account against
 * what was published an hour ago turns that into something the pipeline can
 * see. Accounts absent from either side are skipped — appearing and
 * disappearing is coverage, handled by `checkCoverage` below, not movement.
 */
export function checkScanDelta(
  current: CheckableAccount[],
  previous: CheckableAccount[],
  thresholds: DeltaThresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const prevByAccount = new Map(previous.map((a) => [a.account, a]));
  const findings: Finding[] = [];

  for (const row of current) {
    const before = prevByAccount.get(row.account);
    if (!before) continue;

    const now = Number(row.inbound ?? 0) + Number(row.outbound ?? 0);
    const then = Number(before.inbound ?? 0) + Number(before.outbound ?? 0);
    const change = now - then;

    if (change >= thresholds.minAbsoluteGrowth && then > 0 && now / then > thresholds.maxGrowthFactor) {
      findings.push({
        severity: "error",
        code: "implausible-growth",
        message: `${row.domain} account ${row.account} jumped from ${then} to ${now} payments in one scan (${(now / then).toFixed(1)}x).`,
        detail:
          "An anchor cannot multiply its settlement history several-fold inside one scan interval. " +
          "The usual cause is that the account is now resolving to a different, busier account than before.",
      });
      continue;
    }

    if (
      -change >= thresholds.minAbsoluteShrink &&
      then > 0 &&
      (then - now) / then > thresholds.maxShrinkFraction
    ) {
      findings.push({
        severity: "error",
        code: "implausible-shrink",
        message: `${row.domain} account ${row.account} fell from ${then} to ${now} payments in one scan.`,
        detail:
          "Published counts do not normally collapse — a drop this size means the scan lost records rather " +
          "than that the ledger did, and publishing it would report an outage as an anchor going quiet. " +
          "Most likely cause in this pipeline: the run had no DATABASE_URL, so it re-paged the most recent " +
          "--max-records payments statelessly instead of accumulating via mergeWithHistory, and the published " +
          "figures it is being compared against were built with that history. Expected when running locally; " +
          "if it happens in CI, the database is unreachable and the scan is not publishable until it is back.",
      });
    }
  }

  return findings;
}

/**
 * Anchors and accounts disappearing from coverage.
 *
 * A warning, not an error, and deliberately so. When MoneyGram's only
 * "account" turned out to be Circle's issuer, dropping it was the correct
 * outcome — the right response to that change is a human reading a line in
 * the log, not an hourly job that refuses to publish anything ever again. The
 * loss is also plainly visible on the site, which is exactly what the
 * error-severity checks above are not.
 */
export function checkCoverage(
  current: CheckableAccount[],
  previous: CheckableAccount[],
  thresholds: DeltaThresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const findings: Finding[] = [];

  const nowDomains = new Set(current.map((a) => a.domain));
  const thenDomains = new Set(previous.map((a) => a.domain));
  const lost = [...thenDomains].filter((d) => !nowDomains.has(d));

  if (lost.length > 0 && thenDomains.size > 0) {
    const fraction = lost.length / thenDomains.size;
    if (fraction > thresholds.maxDomainLossFraction) {
      findings.push({
        severity: "warning",
        code: "coverage-loss",
        message: `${lost.length} of ${thenDomains.size} anchors resolved last scan but not this one.`,
        detail: `Missing: ${lost.sort().join(", ")}. Confirm this is a real change (a domain that stopped declaring accounts) rather than a transient resolution failure.`,
      });
    }
  }

  const nowAccounts = new Set(current.map((a) => a.account));
  const droppedAccounts = previous.filter((a) => !nowAccounts.has(a.account));
  if (droppedAccounts.length > 0 && lost.length === 0) {
    findings.push({
      severity: "warning",
      code: "account-dropped",
      message: `${droppedAccounts.length} account(s) were published last scan and are absent now, while their anchor is still covered.`,
      detail: droppedAccounts.map((a) => `${a.domain}:${a.account}`).join(", "),
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

export interface InvariantInput {
  current: CheckableAccount[];
  /** The previously published set. Omit on a first run — movement checks are
   *  simply skipped rather than guessed at. */
  previous?: CheckableAccount[];
  thresholds?: DeltaThresholds;
}

export function runInvariants({ current, previous, thresholds }: InvariantInput): Finding[] {
  const findings: Finding[] = [
    ...checkAccountsAttributed(current),
    ...checkNoDuplicateRows(current),
    ...checkSharedAccounts(current),
  ];

  if (previous && previous.length > 0) {
    findings.push(...checkScanDelta(current, previous, thresholds));
    findings.push(...checkCoverage(current, previous, thresholds));
  }

  // Errors first: the output is read top-down by whoever is deciding whether
  // a failed run needs attention now or at leisure.
  const rank: Record<Severity, number> = { error: 0, warning: 1 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function hasBlockingFinding(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

export function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return "All invariants held.";

  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${f.severity === "error" ? "ERROR" : "WARN "}  [${f.code}] ${f.message}`);
    if (f.detail) lines.push(`         ${f.detail}`);
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  lines.push("");
  lines.push(`${errors} error(s), ${warnings} warning(s).`);
  if (errors > 0) {
    lines.push(
      "Publication blocked. The scan output on disk is intact and can be inspected; " +
        "nothing was written to the site.",
    );
  }
  return lines.join("\n");
}
