/**
 * packages/indexer/src/rpc-events.ts
 *
 * Author: ibochivincent-lang
 *
 * Protocol 23 / CAP-67 Native Stellar RPC Contract Event Ingestion.
 *
 * Uses Stellar RPC (getEvents) to stream and decode smart contract events directly from
 * soroban-rpc. Detects native CAP-67 token operations (mint, burn, transfer) on Stellar
 * Asset Contracts (SAC) and custom Soroban token contracts, providing real-time settlement
 * intelligence for smart contract anchor flows alongside classic Horizon operations.
 */

import { xdr, scValToNative, Address } from "@stellar/stellar-base";

export interface RpcEventFilter {
  type: "contract" | "system" | "diagnostic";
  contractIds?: string[];
  topics?: string[][];
}

export interface RawRpcEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];
  value: string | { xdr: string };
  txHash: string;
}

export interface ParsedContractEvent {
  id: string;
  action: "mint" | "burn" | "transfer" | "clawback" | "unknown";
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  from?: string;
  to?: string;
  amount?: string;
  rawTopics: string[];
}

export interface GetEventsResponse {
  latestLedger: number;
  events: RawRpcEvent[];
}

export class StellarRpcClient {
  private rpcUrl: string;

  constructor(rpcUrl: string = "https://soroban-testnet.stellar.org") {
    this.rpcUrl = rpcUrl;
  }

  /** Send a raw JSON-RPC 2.0 request to the Stellar RPC server. */
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });

    if (!res.ok) {
      throw new Error(`Stellar RPC HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as { result?: T; error?: { code: number; message: string } };
    if (data.error) {
      throw new Error(`Stellar RPC Error (${data.error.code}): ${data.error.message}`);
    }

    return data.result as T;
  }

  /** Get the latest ledger information from the RPC node. */
  async getLatestLedger(): Promise<{ id: string; sequence: number; protocolVersion: number }> {
    return this.request<{ id: string; sequence: number; protocolVersion: number }>("getLatestLedger");
  }

  /** Query contract events from startLedger. */
  async getEvents(params: {
    startLedger: number;
    filters?: RpcEventFilter[];
    limit?: number;
  }): Promise<GetEventsResponse> {
    return this.request<GetEventsResponse>("getEvents", params);
  }
}

/** Formats a 7-decimal Soroban i128 raw integer into a standard decimal string (e.g. 10000000 -> 1.0000000) */
export function formatSorobanAmount(rawVal: bigint | number | string): string {
  const b = typeof rawVal === "bigint" ? rawVal : BigInt(rawVal);
  const negative = b < 0n;
  const abs = negative ? -b : b;
  const divisor = 10_000_000n;
  const intPart = abs / divisor;
  const remPart = abs % divisor;
  const remStr = remPart.toString().padStart(7, "0").replace(/0+$/, "");
  const res = remStr.length > 0 ? `${intPart}.${remStr}` : `${intPart}`;
  return negative ? `-${res}` : res;
}

/** Parses a raw base64 ScVal or XDR into a native address string or representation. */
function parseAddressScVal(rawXdr: string): string {
  try {
    const scVal = xdr.ScVal.fromXDR(rawXdr, "base64");
    const native = scValToNative(scVal);
    if (typeof native === "string") return native;
    if (native && typeof native === "object" && "toString" in native) {
      return (native as { toString(): string }).toString();
    }
    return String(native);
  } catch {
    return rawXdr;
  }
}

/** Decodes raw base64 topics and value from a Stellar RPC event into a structured record. */
export function parseContractEvent(event: RawRpcEvent): ParsedContractEvent {
  const rawValue = typeof event.value === "object" && event.value !== null && "xdr" in event.value
    ? event.value.xdr
    : String(event.value || "");

  let action: ParsedContractEvent["action"] = "unknown";
  let from: string | undefined;
  let to: string | undefined;
  let amount: string | undefined;

  const decodedTopics: unknown[] = [];
  for (const topicB64 of event.topic) {
    try {
      const scVal = xdr.ScVal.fromXDR(topicB64, "base64");
      decodedTopics.push(scValToNative(scVal));
    } catch {
      decodedTopics.push(topicB64);
    }
  }

  const firstTopic = decodedTopics[0];
  if (typeof firstTopic === "string") {
    const normalized = firstTopic.toLowerCase();
    if (normalized === "mint") action = "mint";
    else if (normalized === "burn") action = "burn";
    else if (normalized === "transfer") action = "transfer";
    else if (normalized === "clawback") action = "clawback";
  }

  // Parse counterparties and amount according to SAC standards
  if (action === "mint") {
    // Topics: [Symbol("mint"), Address(admin/minter), Address(to)]
    if (event.topic.length >= 3) {
      to = parseAddressScVal(event.topic[2]!);
    }
  } else if (action === "burn") {
    // Topics: [Symbol("burn"), Address(from)]
    if (event.topic.length >= 2) {
      from = parseAddressScVal(event.topic[1]!);
    }
  } else if (action === "transfer") {
    // Topics: [Symbol("transfer"), Address(from), Address(to)]
    if (event.topic.length >= 3) {
      from = parseAddressScVal(event.topic[1]!);
      to = parseAddressScVal(event.topic[2]!);
    }
  }

  // Parse amount from event value (usually i128)
  if (rawValue) {
    try {
      const valSc = xdr.ScVal.fromXDR(rawValue, "base64");
      const nativeVal = scValToNative(valSc);
      if (typeof nativeVal === "bigint" || typeof nativeVal === "number") {
        amount = formatSorobanAmount(nativeVal);
      } else {
        amount = String(nativeVal);
      }
    } catch {
      // ignore
    }
  }

  return {
    id: event.id,
    action,
    contractId: event.contractId,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    txHash: event.txHash,
    from,
    to,
    amount,
    rawTopics: event.topic,
  };
}

/** Builds CAP-67 topic filters for mint, burn, and transfer symbols. */
export function buildCap67TopicFilters(actions: ("mint" | "burn" | "transfer")[] = ["mint", "burn", "transfer"]): string[][] {
  const topics: string[][] = [];
  for (const act of actions) {
    const sym = xdr.ScVal.scvSymbol(act).toXDR("base64");
    topics.push([sym]);
  }
  return topics;
}
