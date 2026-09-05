export interface Trc20Transfer {
  transactionId: string;
  from: string;
  to: string;
  /** Raw amount, base units. */
  value: bigint;
  decimals: number;
  symbol: string;
  observedAt: string; // ISO-8601
}

interface Trc20TransferRaw {
  transaction_id: string;
  token_info?: { symbol?: string; decimals?: number };
  from: string;
  to: string;
  value: string;
  block_timestamp: number;
  type?: string;
}

/**
 * Pages `GET /v1/accounts/{address}/transactions/trc20` to completion,
 * following TronGrid's `meta.fingerprint` cursor. No try/catch around the
 * loop: a failed page must reach the caller as an error, not come back as
 * a short result set indistinguishable from "this account has fewer
 * transfers than it actually does."
 *
 * https://developers.tron.network/reference/get-trc20-transaction-info-by-account-address
 */
export async function fetchTrc20Transfers(params: {
  apiBase: string;
  address: string;
  contractAddress: string;
  onlyTo?: boolean;
  onlyFrom?: boolean;
  minTimestampMs?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<Trc20Transfer[]> {
  const {
    apiBase,
    address,
    contractAddress,
    onlyTo,
    onlyFrom,
    minTimestampMs,
    limit = 200,
    fetchImpl = fetch,
  } = params;

  const out: Trc20Transfer[] = [];
  let fingerprint: string | undefined;

  for (;;) {
    const query = new URLSearchParams({
      only_confirmed: "true",
      limit: String(limit),
      contract_address: contractAddress,
    });
    if (onlyTo) query.set("only_to", "true");
    if (onlyFrom) query.set("only_from", "true");
    if (minTimestampMs !== undefined) query.set("min_timestamp", String(minTimestampMs));
    if (fingerprint) query.set("fingerprint", fingerprint);

    const url = `${apiBase.replace(/\/$/, "")}/v1/accounts/${address}/transactions/trc20?${query}`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`TronGrid ${res.status} for ${url}`);

    const body = (await res.json()) as {
      success?: boolean;
      data?: Trc20TransferRaw[];
      meta?: { fingerprint?: string };
    };
    if (body.success === false) throw new Error(`TronGrid reported failure for ${url}`);

    const page = body.data ?? [];
    for (const item of page) {
      if (item.type && item.type !== "Transfer") continue;
      out.push({
        transactionId: item.transaction_id,
        from: item.from,
        to: item.to,
        value: BigInt(item.value),
        decimals: item.token_info?.decimals ?? 6,
        symbol: item.token_info?.symbol ?? "USDT",
        observedAt: new Date(item.block_timestamp).toISOString(),
      });
    }

    const next = body.meta?.fingerprint;
    if (!next || page.length < limit) break;
    fingerprint = next;
  }

  return out;
}

/**
 * Independently confirms a transaction succeeded, via the full-node-mirrored
 * `gettransactioninfobyid` endpoint TronGrid also serves.
 */
export async function fetchTransactionSucceeded(params: {
  apiBase: string;
  transactionId: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { apiBase, transactionId, fetchImpl = fetch } = params;
  const url = `${apiBase.replace(/\/$/, "")}/walletsolidity/gettransactioninfobyid`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: transactionId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { receipt?: { result?: string } };
  return body.receipt?.result === "SUCCESS";
}
