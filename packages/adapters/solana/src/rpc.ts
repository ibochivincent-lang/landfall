export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

interface JsonRpcErrorBody {
  error?: { code: number; message: string };
}

async function callRpc<T>(rpcUrl: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = (await res.json()) as JsonRpcErrorBody & { result: T };
  if (body.error) throw new Error(`${method} RPC error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

/**
 * Pages `getSignaturesForAddress` backward (newest-first, following `before`)
 * until either the account's full history or `stopAtBlockTime`/`stopAtSlot`
 * is reached. No try/catch: a failed page must reach the caller as an
 * error, not come back as a short, undercounted result set.
 */
export async function getSignaturesForAddress(params: {
  rpcUrl: string;
  address: string;
  stopAtBlockTime?: number;
  stopAtSlot?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<SignatureInfo[]> {
  const { rpcUrl, address, stopAtBlockTime, stopAtSlot, limit = 1000, fetchImpl = fetch } = params;

  const out: SignatureInfo[] = [];
  let before: string | undefined;

  for (;;) {
    const page = await callRpc<SignatureInfo[]>(
      rpcUrl,
      "getSignaturesForAddress",
      [address, { limit, before }],
      fetchImpl,
    );
    if (page.length === 0) break;

    let hitBoundary = false;
    for (const entry of page) {
      if (stopAtSlot !== undefined && entry.slot < stopAtSlot) {
        hitBoundary = true;
        break;
      }
      if (stopAtBlockTime !== undefined && entry.blockTime !== null && entry.blockTime < stopAtBlockTime) {
        hitBoundary = true;
        break;
      }
      out.push(entry);
    }

    if (hitBoundary || page.length < limit) break;
    before = page[page.length - 1]?.signature;
  }

  return out;
}

export interface TokenBalanceDelta {
  signature: string;
  /** SPL token account address whose balance changed — the address scan() was called with. */
  tokenAccount: string;
  owner: string;
  mint: string;
  decimals: number;
  /** Signed change in base units: positive = inbound, negative = outbound. */
  delta: bigint;
  observedAt: string; // ISO-8601, from blockTime
}

interface ParsedTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface ParsedTransaction {
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: ParsedTokenBalance[];
    postTokenBalances?: ParsedTokenBalance[];
  } | null;
  transaction: {
    message: { accountKeys: Array<string | { pubkey: string }> };
  };
}

function keyAt(tx: ParsedTransaction, index: number): string | undefined {
  const key = tx.transaction.message.accountKeys[index];
  return typeof key === "string" ? key : key?.pubkey;
}

/**
 * Fetches one transaction and reduces it to the balance change for exactly
 * `tokenAccount`, using the RPC's own pre/postTokenBalances diff rather than
 * decoding SPL instructions — robust across transfer/transferChecked and
 * any future instruction shape, since the diff is computed from account
 * state, not from which instruction moved it.
 *
 * Returns null for a failed transaction (Solana transactions are atomic, so
 * a failed one moved no token balances) or one that didn't touch
 * `tokenAccount` at all.
 */
export async function getTokenBalanceDelta(params: {
  rpcUrl: string;
  signature: string;
  tokenAccount: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenBalanceDelta | null> {
  const { rpcUrl, signature, tokenAccount, fetchImpl = fetch } = params;
  const tx = await callRpc<ParsedTransaction | null>(
    rpcUrl,
    "getTransaction",
    [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    fetchImpl,
  );
  if (!tx || !tx.meta || tx.meta.err) return null;

  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];

  const postEntry = post.find((b) => keyAt(tx, b.accountIndex) === tokenAccount);
  if (!postEntry) return null;
  const preEntry = pre.find((b) => b.accountIndex === postEntry.accountIndex);

  const postAmount = BigInt(postEntry.uiTokenAmount.amount);
  const preAmount = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
  const delta = postAmount - preAmount;
  if (delta === 0n) return null;

  if (tx.blockTime === null) {
    throw new Error(`getTokenBalanceDelta: transaction ${signature} has no blockTime`);
  }

  return {
    signature,
    tokenAccount,
    owner: postEntry.owner ?? preEntry?.owner ?? "",
    mint: postEntry.mint,
    decimals: postEntry.uiTokenAmount.decimals,
    delta,
    observedAt: new Date(tx.blockTime * 1000).toISOString(),
  };
}

/** Independently re-checks that a transaction succeeded, for verify(). */
export async function transactionSucceeded(params: {
  rpcUrl: string;
  signature: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { rpcUrl, signature, fetchImpl = fetch } = params;
  const tx = await callRpc<ParsedTransaction | null>(
    rpcUrl,
    "getTransaction",
    [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    fetchImpl,
  );
  return tx !== null && tx.meta !== null && tx.meta.err === null;
}
