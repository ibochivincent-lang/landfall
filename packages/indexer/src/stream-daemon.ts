/**
 * packages/indexer/src/stream-daemon.ts
 *
 * Author: ibochivincent-lang
 *
 * Continuous, sub-minute ingestion daemon for Landfall.
 *
 * Instead of waiting for the periodic 2.8-hour batch cron, this daemon tails
 * the live Horizon payment stream via Server-Sent Events (SSE) or tight cursor polling.
 * When a payment touches any tracked anchor account (inbound or outbound), it is
 * processed and persisted immediately, and account liveness is refreshed in real time.
 *
 * Run:
 *   npx tsx packages/indexer/src/stream-daemon.ts
 *   DATABASE_URL=... HORIZON_URL=... npx tsx packages/indexer/src/stream-daemon.ts
 */

import { readFile } from "node:fs/promises";
import { Store } from "./db.js";
import { normalise } from "./horizon.js";
import type { PaymentRecord } from "./types.js";
import { StellarRpcClient, parseContractEvent, buildCap67TopicFilters } from "./rpc-events.js";

const DEFAULT_HORIZON = "https://horizon.stellar.org";
const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const STREAM_KEY = "global_payments";

export interface StreamDaemonOptions {
  horizonUrl?: string;
  rpcUrl?: string;
  connectionString?: string;
  seedFile?: string;
}

export class StreamDaemon {
  private horizonUrl: string;
  private rpcUrl: string;
  private rpcClient: StellarRpcClient;
  private connectionString?: string;
  private store?: Store;
  private trackedAccounts = new Set<string>();
  private running = false;
  private abortController?: AbortController;

  constructor(opts: StreamDaemonOptions = {}) {
    this.horizonUrl = opts.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON;
    this.rpcUrl = opts.rpcUrl || process.env.STELLAR_RPC_URL || DEFAULT_RPC;
    this.rpcClient = new StellarRpcClient(this.rpcUrl);
    this.connectionString = opts.connectionString || process.env.DATABASE_URL;
  }

  /** Loads all known anchor accounts to filter live streaming payments in memory. */
  async loadTrackedAccounts(): Promise<number> {
    this.trackedAccounts.clear();

    // 1. Seed accounts from JSON
    try {
      const seedUrl = new URL("../data/anchors.json", import.meta.url);
      const raw = await readFile(seedUrl, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.anchors)) {
        for (const a of parsed.anchors) {
          if (Array.isArray(a.accounts)) {
            for (const acc of a.accounts) {
              if (acc.account) this.trackedAccounts.add(acc.account);
            }
          }
        }
      }
    } catch {
      // JSON seed optional
    }

    // 2. Database accounts if available
    if (this.store) {
      try {
        const { rows } = await (this.store as any).pool.query(
          "SELECT account_id FROM anchor_accounts"
        );
        for (const r of rows) {
          if (r.account_id) this.trackedAccounts.add(r.account_id);
        }
      } catch (err: any) {
        process.stderr.write(`[daemon] Notice: could not load anchor_accounts from DB (${err.message})\n`);
      }
    }

    return this.trackedAccounts.size;
  }

  async start(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();

    if (this.connectionString) {
      try {
        this.store = new Store({ connectionString: this.connectionString });
        await this.store.assertReady();
        console.log("[daemon] Connected to Postgres store.");
      } catch (err: any) {
        console.warn(`[daemon] Database connection failed (${err.message}). Running in monitor-only mode.`);
        this.store = undefined;
      }
    }

    const count = await this.loadTrackedAccounts();
    console.log(`[daemon] Monitoring ${count} tracked anchor account(s) on ${this.horizonUrl}...`);

    // Start companion CAP-67 RPC contract event poller in background
    this.startRpcContractPoller().catch((err: any) => {
      console.warn(`[daemon] RPC contract poller halted (${err.message}).`);
    });

    let cursor = "now";
    if (this.store) {
      const savedCursor = await this.store.getCursor("horizon_stream", STREAM_KEY);
      if (savedCursor) cursor = savedCursor;
    }

    while (this.running) {
      try {
        cursor = await this.streamPayments(cursor);
      } catch (err: any) {
        if (!this.running) break;
        console.error(`[daemon] Stream disconnected (${err.message}). Reconnecting in 5s...`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private async startRpcContractPoller(): Promise<void> {
    console.log(`[daemon] Initializing Protocol 23 / CAP-67 RPC poller on ${this.rpcUrl}...`);
    let startLedger = 0;
    try {
      const latest = await this.rpcClient.getLatestLedger();
      startLedger = latest.sequence;
    } catch {
      return; // Soroban RPC offline or non-blocking
    }

    const filters = [{
      type: "contract" as const,
      topics: buildCap67TopicFilters(["mint", "burn", "transfer"]),
    }];

    while (this.running) {
      try {
        const res = await this.rpcClient.getEvents({
          startLedger,
          filters,
          limit: 100,
        });

        if (res.events && res.events.length > 0) {
          for (const raw of res.events) {
            const ev = parseContractEvent(raw);
            if (ev.action === "mint" || ev.action === "burn" || ev.action === "transfer") {
              const fromTracked = ev.from ? this.trackedAccounts.has(ev.from) : false;
              const toTracked = ev.to ? this.trackedAccounts.has(ev.to) : false;
              if (fromTracked || toTracked) {
                console.log(
                  `[daemon] LIVE CAP-67 ${ev.action.toUpperCase()}: ${ev.amount || "?"} SAC | Contract: ${ev.contractId.slice(0, 8)}... | From: ${ev.from?.slice(0, 8) || "mint"} -> To: ${ev.to?.slice(0, 8) || "burn"}`
                );
              }
            }
          }
          startLedger = res.latestLedger + 1;
        } else if (res.latestLedger >= startLedger) {
          startLedger = res.latestLedger + 1;
        }
      } catch {
        // backoff
      }
      await new Promise((r) => setTimeout(r, 6_000));
    }
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.store?.close().catch(() => {});
    console.log("[daemon] Stream daemon stopped gracefully.");
  }

  private async streamPayments(initialCursor: string): Promise<string> {
    let cursor = initialCursor;
    const url = `${this.horizonUrl}/payments?cursor=${cursor}&order=asc&limit=100`;

    const res = await fetch(url, {
      headers: {
        accept: "text/event-stream",
        "user-agent": "landfall-stream-daemon/0.2.0",
      },
      signal: this.abortController?.signal,
    });

    if (!res.ok) {
      throw new Error(`Horizon stream returned HTTP ${res.status}`);
    }

    if (!res.body) {
      throw new Error("No response body received from Horizon stream");
    }

    console.log(`[daemon] SSE stream open at cursor ${cursor}. Real-time settlement monitoring active.`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (this.running) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";

      for (const block of lines) {
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            const rawJson = line.slice(6).trim();
            if (rawJson === '"hello"' || !rawJson.startsWith("{")) continue;

            try {
              const rec = JSON.parse(rawJson);
              if (rec.paging_token) cursor = rec.paging_token;

              const payment = normalise(rec);
              if (payment) {
                await this.handlePayment(payment);
              }
            } catch (err: any) {
              console.error("[daemon] Parse error on stream record:", err.message);
            }
          }
        }
      }

      // Checkpoint cursor every minute or batch
      if (this.store && cursor !== "now") {
        await this.store.setCursor("horizon_stream", STREAM_KEY, cursor).catch(() => {});
      }
    }

    return cursor;
  }

  private async handlePayment(p: PaymentRecord): Promise<void> {
    const fromTracked = this.trackedAccounts.has(p.from);
    const toTracked = this.trackedAccounts.has(p.to);

    if (!fromTracked && !toTracked) return;

    const role = fromTracked && toTracked ? "inter-anchor" : fromTracked ? "outbound" : "inbound";
    console.log(
      `[daemon] LIVE SETTLEMENT (${role}): ${p.amount} ${p.asset} | From: ${p.from.slice(0, 8)}... -> To: ${p.to.slice(0, 8)}... (tx ${p.txHash.slice(0, 8)}...)`
    );

    if (this.store) {
      // 1. Insert payment record
      await this.store.insertPayments([p], new Set()).catch((e) => {
        console.error(`[daemon] Failed to insert payment ${p.txHash}:`, e.message);
      });

      // 2. Refresh liveness timestamp immediately
      if (fromTracked) await this.store.setLiveness(p.from, p.createdAt).catch(() => {});
      if (toTracked) await this.store.setLiveness(p.to, p.createdAt).catch(() => {});
    }
  }
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("stream-daemon.ts")) {
  const daemon = new StreamDaemon();
  process.on("SIGINT", () => daemon.stop());
  process.on("SIGTERM", () => daemon.stop());
  daemon.start().catch((err) => {
    console.error("[daemon] Fatal error:", err);
    process.exit(1);
  });
}
