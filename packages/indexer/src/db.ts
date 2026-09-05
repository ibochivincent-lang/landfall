/**
 * Postgres persistence for the indexer.
 *
 * Two rules shape everything here:
 *
 *   1. Raw records are stored verbatim alongside the metrics derived from
 *      them. If a published figure and its inputs ever disagree, the inputs
 *      win and the metric is the bug.
 *   2. Cursors live in the database, so an interrupted run resumes where it
 *      stopped. The failure mode is stale data, never wrong data.
 *
 * The module is optional at runtime — the CLI works fully without a database,
 * writing JSON as before. `--persist` opts in.
 */

import { Pool, type PoolClient } from "pg";
import type { AccountMetrics, AnchorAccount, PaymentRecord, ScanOptions } from "./types.js";

export interface DbOptions {
  connectionString: string;
  /** Fail fast rather than hanging a scan on an unreachable database. */
  connectionTimeoutMillis?: number;
}

export class Store {
  private pool: Pool;

  constructor(opts: DbOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 8_000,
      max: 6,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Confirm the schema is present before a scan does any work. */
  async assertReady(): Promise<void> {
    const { rows } = await this.pool.query<{ version: number }>(
      "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
    );
    if (rows.length === 0) {
      throw new Error("Database reachable but not migrated. Run: npm run db:migrate");
    }
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------- anchors */

  async upsertAnchor(domain: string, orgName?: string, error?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO anchors (domain, org_name, last_resolved_at, resolve_error)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (domain) DO UPDATE
         SET org_name         = COALESCE(EXCLUDED.org_name, anchors.org_name),
             last_resolved_at = now(),
             resolve_error    = EXCLUDED.resolve_error`,
      [domain, orgName ?? null, error ?? null],
    );
  }

  async upsertAccounts(accounts: AnchorAccount[]): Promise<void> {
    if (accounts.length === 0) return;
    await this.tx(async (c) => {
      for (const a of accounts) {
        await c.query(
          `INSERT INTO anchor_accounts (account_id, domain, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (account_id) DO UPDATE SET domain = EXCLUDED.domain`,
          [a.account, a.domain, a.role],
        );
      }
    });
  }

  /** Liveness is written from the unfiltered lifetime reading, never the window. */
  async setLiveness(account: string, lastActivityAt?: string): Promise<void> {
    await this.pool.query(
      // $2 is cast explicitly: it appears only inside IS NOT NULL, which gives
      // Postgres no type context to infer from (SQLSTATE 42P08).
      `UPDATE anchor_accounts
          SET last_activity_at = $2::timestamptz,
              has_lifetime_activity = ($2::timestamptz IS NOT NULL)
        WHERE account_id = $1`,
      [account, lastActivityAt ?? null],
    );
  }

  /* ---------------------------------------------------------------- cursors */

  async getCursor(stream: string, key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ cursor: string }>(
      "SELECT cursor FROM cursors WHERE stream = $1 AND key = $2",
      [stream, key],
    );
    return rows[0]?.cursor;
  }

  async setCursor(stream: string, key: string, cursor: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO cursors (stream, key, cursor) VALUES ($1, $2, $3)
       ON CONFLICT (stream, key) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
      [stream, key, cursor],
    );
  }

  /* ---------------------------------------------------------------- payments */

  async insertPayments(records: PaymentRecord[], dustCursors: Set<string>): Promise<number> {
    if (records.length === 0) return 0;
    return this.tx(async (c) => {
      let written = 0;
      for (const r of records) {
        const res = await c.query(
          `INSERT INTO payments
             (paging_token, tx_hash, op_type, from_account, to_account,
              amount, asset, source_amount, source_asset, memo, memo_type, created_at, source, is_dust)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'horizon_rest',$13)
           ON CONFLICT (paging_token, source) DO NOTHING`,
          [
            r.cursor, r.txHash, r.type, r.from, r.to,
            r.amount, r.asset, r.sourceAmount ?? null, r.sourceAsset ?? null, r.memo ?? null, r.memoType ?? null,
            r.createdAt, dustCursors.has(r.cursor),
          ],
        );
        written += res.rowCount ?? 0;
      }
      return written;
    });
  }

  /**
   * Every payment already persisted for one account, newest first.
   *
   * This exists because an incremental scan fetches only what is new since the
   * stored cursor, and metrics computed from that alone describe the last hour
   * rather than the anchor's settlement record. Published numbers must be
   * cumulative, so they are computed over persisted history plus the new
   * records — the ledger is the input, the `payments` table is our copy of it,
   * and the fetch window is an implementation detail that must not leak into a
   * figure. See computeMetrics() in cli.ts.
   *
   * `limit` is a memory guard, not a sampling decision. Hitting it means the
   * published counts would understate reality, so the caller reports it rather
   * than quietly truncating — silently dropping records is the one failure mode
   * SECURITY.md calls the worst this project can have.
   */
  async paymentsForAccount(
    account: string,
    opts: { since?: string; limit?: number } = {},
  ): Promise<{ records: PaymentRecord[]; truncated: boolean }> {
    const limit = opts.limit ?? 100_000;
    const { rows } = await this.pool.query<{
      paging_token: string;
      tx_hash: string;
      op_type: string;
      from_account: string;
      to_account: string;
      amount: string;
      asset: string;
      source_amount: string | null;
      source_asset: string | null;
      memo: string | null;
      memo_type: string | null;
      created_at: Date;
    }>(
      `SELECT paging_token, tx_hash, op_type, from_account, to_account,
              amount::text        AS amount,
              asset,
              source_amount::text AS source_amount,
              source_asset, memo, memo_type, created_at
         FROM payments
        WHERE (from_account = $1 OR to_account = $1)
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        ORDER BY created_at DESC
        LIMIT $3`,
      [account, opts.since ?? null, limit + 1],
    );

    const truncated = rows.length > limit;
    const use = truncated ? rows.slice(0, limit) : rows;

    return {
      truncated,
      records: use.map((r) => ({
        cursor: r.paging_token,
        type: r.op_type,
        txHash: r.tx_hash,
        from: r.from_account,
        to: r.to_account,
        // NUMERIC comes back as a string via ::text so the exact seven-decimal
        // value survives; going through a JS number here would reintroduce the
        // float drift the stroop arithmetic exists to avoid.
        amount: r.amount,
        asset: r.asset,
        sourceAmount: r.source_amount ?? undefined,
        sourceAsset: r.source_asset ?? undefined,
        createdAt: r.created_at.toISOString(),
        memo: r.memo ?? undefined,
        memoType: r.memo_type ?? undefined,
      })),
    };
  }

  /* ---------------------------------------------------------------- scans */

  async startScan(horizon: string, options: ScanOptions): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      "INSERT INTO scans (horizon_url, options) VALUES ($1, $2) RETURNING id",
      [horizon, JSON.stringify(options)],
    );
    return Number(rows[0]!.id);
  }

  async finishScan(scanId: number, accountsSeen: number, notes?: string): Promise<void> {
    await this.pool.query(
      "UPDATE scans SET finished_at = now(), accounts_seen = $2, notes = $3 WHERE id = $1",
      [scanId, accountsSeen, notes ?? null],
    );
  }

  /** Persist one account's computed metrics, its per-asset totals and its refund pairs. */
  async writeMetrics(scanId: number, m: AccountMetrics, state: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO account_metrics
           (scan_id, account_id, sampled, dust_excluded, window_start, window_end,
            last_activity_at, hours_since_activity, state,
            inbound_count, outbound_count, inbound_counterparties, outbound_counterparties,
            refund_count, refund_rate, median_refund_hours, top_counterparty_share)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (scan_id, account_id) DO UPDATE SET
           sampled = EXCLUDED.sampled, state = EXCLUDED.state`,
        [
          scanId, m.account, m.sampled, m.dustExcluded,
          m.windowStart ?? null, m.windowEnd ?? null,
          m.lastActivityAt ?? null, m.hoursSinceLastActivity ?? null, state,
          m.inbound.count, m.outbound.count,
          m.inbound.uniqueCounterparties, m.outbound.uniqueCounterparties,
          m.refundCount,
          // NULL, not 0. A rate over no traffic is unknown, not zero, and the
          // distinction has to survive all the way to the API.
          m.refundRate, m.medianRefundLatencyHours, m.topCounterpartyShare,
        ],
      );

      for (const [direction, totals] of [
        ["inbound", m.inbound.byAsset],
        ["outbound", m.outbound.byAsset],
      ] as const) {
        for (const t of totals) {
          await c.query(
            `INSERT INTO asset_totals (scan_id, account_id, direction, asset, count, volume)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (scan_id, account_id, direction, asset) DO UPDATE
               SET count = EXCLUDED.count, volume = EXCLUDED.volume`,
            [scanId, m.account, direction, t.asset, t.count, t.volume],
          );
        }
      }

      for (const r of m.refunds) {
        await c.query(
          `INSERT INTO refund_pairs
             (scan_id, account_id, counterparty, asset, in_amount, out_amount,
              in_at, out_at, latency_hours, in_tx_hash, out_tx_hash, confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            scanId, m.account, r.counterparty, r.asset, r.inAmount, r.outAmount,
            r.inAt, r.outAt, r.latencyHours, r.inTxHash, r.outTxHash,
            r.confidence ?? "heuristic",
          ],
        );
      }
    });
  }

  /* --------------------------------------------------------- tracked anchors */

  /**
   * Active domains added through the admin board. Additive to the seed list
   * in packages/indexer/data/anchors.json — see loadDomains() in cli.ts.
   * Failure here must never fail a scan, so callers should catch and fall
   * back to the seed list alone.
   */
  async trackedDomains(): Promise<string[]> {
    const { rows } = await this.pool.query<{ domain: string }>(
      "SELECT domain FROM tracked_anchors WHERE active = true ORDER BY domain",
    );
    return rows.map((r) => r.domain);
  }
}

/** Read the connection string from the environment, or undefined if unset. */
export function connectionStringFromEnv(): string | undefined {
  return process.env["DATABASE_URL"] || undefined;
}
