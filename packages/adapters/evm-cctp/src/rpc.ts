export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

interface JsonRpcErrorBody {
  error?: { code: number; message: string };
}

/**
 * Reads DepositForBurn-shaped logs from an EVM JSON-RPC endpoint. No
 * try/catch here: a failed or truncated `eth_getLogs` call must reach the
 * caller as an error, not come back as an empty (and indistinguishable
 * from "no burns happened") result set.
 */
export async function ethGetLogs(params: {
  rpcUrl: string;
  address: string;
  topics: (string | null)[];
  fromBlock: string;
  toBlock: string;
  fetchImpl?: typeof fetch;
}): Promise<EthLog[]> {
  const { rpcUrl, address, topics, fromBlock, toBlock, fetchImpl = fetch } = params;
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{ address, topics, fromBlock, toBlock }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`eth_getLogs HTTP ${res.status}`);
  const body = (await res.json()) as JsonRpcErrorBody & { result?: EthLog[] };
  if (body.error) throw new Error(`eth_getLogs RPC error ${body.error.code}: ${body.error.message}`);
  return body.result ?? [];
}

/**
 * Resolves block timestamps in one batched JSON-RPC call, so scan() can
 * report `observedAt` as when the settlement actually happened rather than
 * substituting the time of the scan — a batch is used instead of one
 * request per log because many burns typically share a block.
 */
export async function ethGetBlockTimestamps(params: {
  rpcUrl: string;
  blockNumbers: string[];
  fetchImpl?: typeof fetch;
}): Promise<Map<string, string>> {
  const { rpcUrl, blockNumbers, fetchImpl = fetch } = params;
  const unique = [...new Set(blockNumbers)];
  if (unique.length === 0) return new Map();

  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      unique.map((blockNumber, id) => ({
        jsonrpc: "2.0",
        id,
        method: "eth_getBlockByNumber",
        params: [blockNumber, false],
      })),
    ),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`eth_getBlockByNumber HTTP ${res.status}`);

  const bodies = (await res.json()) as Array<
    JsonRpcErrorBody & { id: number; result?: { timestamp?: string } }
  >;

  const out = new Map<string, string>();
  for (const item of bodies) {
    if (item.error) {
      throw new Error(`eth_getBlockByNumber RPC error ${item.error.code}: ${item.error.message}`);
    }
    const blockNumber = unique[item.id];
    const timestampHex = item.result?.timestamp;
    if (blockNumber === undefined || !timestampHex) continue;
    out.set(blockNumber, new Date(Number(BigInt(timestampHex)) * 1000).toISOString());
  }
  return out;
}
