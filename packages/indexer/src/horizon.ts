import type { PaymentRecord } from "./types.js";

/** Canonical asset id used throughout: "native" or "CODE:ISSUER". */
export function assetId(rec: Record<string, unknown>): string {
  const type = rec["asset_type"];
  if (type === "native" || type === undefined) return "native";
  const code = rec["asset_code"];
  const issuer = rec["asset_issuer"];
  if (typeof code === "string" && typeof issuer === "string") return `${code}:${issuer}`;
  return typeof code === "string" ? code : "unknown";
}

export function sourceAssetId(rec: Record<string, unknown>): string {
  const type = rec["source_asset_type"];
  if (type === "native") return "native";
  const code = rec["source_asset_code"];
  const issuer = rec["source_asset_issuer"];
  if (typeof code === "string" && typeof issuer === "string") return `${code}:${issuer}`;
  return typeof code === "string" ? code : "unknown";
}

/**
 * Normalise a Horizon operation into a PaymentRecord.
 * Returns null for operation types that carry no transfer we can attribute
 * (e.g. change_trust showing up in a mixed feed).
 */
export function normalise(rec: Record<string, unknown>): PaymentRecord | null {
  const type = String(rec["type"] ?? "");
  const cursor = String(rec["paging_token"] ?? "");
  const txHash = String(rec["transaction_hash"] ?? "");
  const createdAt = String(rec["created_at"] ?? "");

  if (type === "create_account") {
    const funder = rec["funder"];
    const account = rec["account"];
    const starting = rec["starting_balance"];
    if (typeof funder !== "string" || typeof account !== "string") return null;
    return {
      cursor,
      type,
      txHash,
      from: funder,
      to: account,
      amount: String(starting ?? "0"),
      asset: "native",
      createdAt,
    };
  }

  // payment, path_payment_strict_receive, path_payment_strict_send
  const from = rec["from"];
  const to = rec["to"];
  if (typeof from !== "string" || typeof to !== "string") return null;

  const isPath = type.startsWith("path_payment");

  return {
    cursor,
    type,
    txHash,
    from,
    to,
    // path payments report the delivered amount in `amount`
    amount: String(rec["amount"] ?? "0"),
    asset: assetId(rec),
    sourceAmount: isPath ? String(rec["source_amount"] ?? "0") : undefined,
    sourceAsset: isPath ? sourceAssetId(rec) : undefined,
    createdAt,
  };
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  attempt = 0,
): Promise<Record<string, unknown>> {
  // 15s: long enough that a merely slow Horizon page is not mistaken for a
  // failure, short enough that one stuck request cannot hold an hourly run
  // open. The earlier 8s was fast but turned ordinary latency into an error,
  // and an error here used to be swallowed - see fetchPayments below.
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  // Horizon rate-limits with 429; back off and retry. The budget is generous
  // on purpose: a scan that gives up early on rate limiting reports fewer
  // payments than the ledger holds, and an undercount is indistinguishable
  // from an anchor that stopped settling. Waiting is cheap, being wrong is not.
  if (res.status === 429 && attempt < 4) {
    const waitMs = 500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, waitMs));
    return getJson(url, fetchImpl, attempt + 1);
  }
  if (!res.ok) throw new Error(`Horizon ${res.status} for ${url}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Fetch the single newest payment for an account, ignoring any `since` window.
 *
 * Liveness must be measured against the whole ledger, not the analysis window.
 * An account whose last payment was two years ago returns zero records under a
 * `--since 2026-01-01` scan; reading that as "no history" would silently drop
 * the most dormant accounts from the dark count. This call exists so dormancy
 * and volume are measured independently.
 *
 * Returns null when the account genuinely has no payment history.
 */
export async function fetchLastActivity(
  horizon: string,
  account: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ createdAt: string; totalKnown: number } | null> {
  // No try/catch: a Horizon error here must reach the caller. Returning null on
  // failure is indistinguishable from "this account has never transacted", so
  // swallowing it would report a live anchor as having no history at all - the
  // single most damaging thing this project can get wrong about a named
  // business. The caller logs the error and drops the account from the run
  // rather than publishing a figure it did not measure.
  const url = `${horizon.replace(/\/$/, "")}/accounts/${account}/payments?limit=1&order=desc`;
  const body = await getJson(url, fetchImpl);
  const embedded = body["_embedded"] as { records?: unknown[] } | undefined;
  const records = embedded?.records ?? [];
  const first = records[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  const createdAt = String(first["created_at"] ?? "");
  if (!createdAt) return null;
  return { createdAt, totalKnown: records.length };
}

export interface FetchPaymentsArgs {
  horizon: string;
  account: string;
  maxRecords: number;
  /** Stop paging once records are older than this ISO timestamp. */
  since?: string;
  /** Resume from a previously stored cursor. */
  cursor?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (fetched: number) => void;
}

/**
 * Page an account's payment history.
 *
 * When resuming from a stored cursor, queries forward (order=asc) to only
 * fetch new transactions since the last scan, making hourly runs finish in seconds.
 */
export async function fetchPayments({
  horizon,
  account,
  maxRecords,
  since,
  cursor,
  fetchImpl = fetch,
  onProgress,
}: FetchPaymentsArgs): Promise<{ records: PaymentRecord[]; newestCursor?: string }> {
  const out: PaymentRecord[] = [];
  const sinceMs = since ? Date.parse(since) : undefined;

  const isIncremental = Boolean(cursor);
  const order = isIncremental ? "asc" : "desc";
  const params = new URLSearchParams({ limit: "200", order });
  if (cursor) params.set("cursor", cursor);
  let url = `${horizon.replace(/\/$/, "")}/accounts/${account}/payments?${params}`;

  // Track the newest record by timestamp rather than by position in the page.
  // Position only identifies the newest under `order=desc`; an incremental run
  // pages ascending, where the newest is last. Comparing dates is correct under
  // both, and a cursor that is not actually the newest either re-reads history
  // forever or, worse, advances past records that were never stored.
  // Starts undefined, not at the incoming cursor: a resumed page that comes
  // back empty must report "nothing new" rather than echoing the cursor it was
  // handed, so the caller leaves the stored one alone instead of writing over
  // a good value with a derived one. Covered by a test.
  let newestCursor: string | undefined;
  let newestAt = -Infinity;

  // No try/catch around the paging loop. A failed page used to `break`, which
  // ended the walk early and returned a short record set that looked exactly
  // like a complete one - the caller could not tell "this anchor settled twice
  // this week" from "Horizon timed out after two pages". SECURITY.md names
  // that precise behaviour ("causing the indexer to silently drop records
  // rather than report a gap") as the worst class of bug here, so the error
  // propagates: cli.ts logs it and drops the account from the run instead of
  // publishing an undercount as though it were a measurement.
  while (url && out.length < maxRecords) {
    const body = await getJson(url, fetchImpl);
    const embedded = body["_embedded"] as { records?: unknown[] } | undefined;
    const records = embedded?.records ?? [];
    if (records.length === 0) break;

    let hitSinceBoundary = false;

    for (const raw of records) {
      const rec = normalise(raw as Record<string, unknown>);
      if (!rec) continue;

      const at = Date.parse(rec.createdAt);
      if (Number.isFinite(at) && at > newestAt) {
        newestAt = at;
        newestCursor = rec.cursor;
      }

      if (sinceMs !== undefined && Date.parse(rec.createdAt) < sinceMs) {
        hitSinceBoundary = true;
        break;
      }
      out.push(rec);
      if (out.length >= maxRecords) break;
    }

    onProgress?.(out.length);
    if (hitSinceBoundary || out.length >= maxRecords) break;

    const links = body["_links"] as { next?: { href?: string } } | undefined;
    const next = links?.next?.href;
    if (!next || next === url) break;
    url = next;
  }

  return { records: out, newestCursor };
}
