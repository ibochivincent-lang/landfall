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
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  // Horizon rate-limits with 429; back off and retry a few times.
  if (res.status === 429 && attempt < 4) {
    const waitMs = 1000 * 2 ** attempt;
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
 * Page an account's payment history newest-first.
 *
 * The returned `nextCursor` is the paging token of the newest record seen, so
 * a later run can resume forward rather than re-reading history. This is why
 * the indexer degrades to "stale" rather than "broken": no probe to fail, and
 * nothing lost when it stops.
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

  const params = new URLSearchParams({ limit: "200", order: "desc" });
  if (cursor) params.set("cursor", cursor);
  let url = `${horizon.replace(/\/$/, "")}/accounts/${account}/payments?${params}`;

  let newestCursor: string | undefined;

  while (url && out.length < maxRecords) {
    const body = await getJson(url, fetchImpl);
    const embedded = body["_embedded"] as { records?: unknown[] } | undefined;
    const records = embedded?.records ?? [];
    if (records.length === 0) break;

    let hitSinceBoundary = false;

    for (const raw of records) {
      const rec = normalise(raw as Record<string, unknown>);
      if (!rec) continue;
      if (!newestCursor) newestCursor = rec.cursor;
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
