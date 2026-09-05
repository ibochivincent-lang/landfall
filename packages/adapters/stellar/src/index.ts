import { fetchPayments } from "../../../indexer/src/horizon.js";
import type { ChainAdapter, EvidenceTier, ScanOpts, SettlementEvent } from "../../src/types.js";

export interface StellarAdapterOptions {
  /** Horizon base URL. Defaults to the public mainnet Horizon. */
  horizon?: string;
  /** Per-account cap on records paged in a single scan() call. */
  maxRecords?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_HORIZON = "https://horizon.stellar.org";
const DEFAULT_MAX_RECORDS = 10_000;

function assetCode(canonicalAsset: string): string {
  if (canonicalAsset === "native") return "XLM";
  return canonicalAsset.split(":")[0] ?? canonicalAsset;
}

/**
 * The keystone-chain adapter (MULTICHAIN.md §1, §6.1). Stellar is the one
 * chain this whole protocol can prove from directly — this adapter's
 * maxTier is PROVEN and it stays that way for every event it emits.
 *
 * It reads through the indexer's already-tested `fetchPayments` rather than
 * re-implementing Horizon paging, so pagination/cursor/dust-adjacent bugs
 * aren't duplicated into a second codepath.
 *
 * `anchorId` is a Stellar account address (G...) for now, not a resolved
 * anchor-registry id — SEP-1 identity resolution (MULTICHAIN.md §5,
 * `anchors.registry.json`) isn't wired up yet, so callers pass the account
 * directly until it is.
 */
export class StellarAdapter implements ChainAdapter {
  readonly chain = "stellar";
  readonly maxTier: EvidenceTier = "PROVEN";

  private readonly horizon: string;
  private readonly maxRecords: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StellarAdapterOptions = {}) {
    this.horizon = options.horizon ?? DEFAULT_HORIZON;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *scan(anchorId: string, opts: ScanOpts = {}): AsyncIterable<SettlementEvent> {
    // Loud failure, not a silent no-op: this project's whole premise is that
    // published numbers must be provably complete. A range filter we can't
    // honor must say so, not quietly scan everything instead.
    if (opts.toLedgerOrBlock !== undefined) {
      throw new Error(
        "StellarAdapter.scan: toLedgerOrBlock is not implemented — Horizon paging here has no upper bound yet.",
      );
    }
    if (typeof opts.fromLedgerOrBlock === "number") {
      throw new Error(
        "StellarAdapter.scan: numeric ledger-sequence filtering is not implemented — " +
          "pass an ISO-8601 string (mapped to Horizon's `since`) in fromLedgerOrBlock, or omit it.",
      );
    }

    const account = anchorId;
    const { records } = await fetchPayments({
      horizon: this.horizon,
      account,
      maxRecords: this.maxRecords,
      since: opts.fromLedgerOrBlock,
      fetchImpl: this.fetchImpl,
    });

    const minAmount = opts.minAmount !== undefined ? Number(opts.minAmount) : undefined;

    for (const rec of records) {
      const isInbound = rec.to === account;
      const isOutbound = rec.from === account;
      if (!isInbound && !isOutbound) continue;
      if (minAmount !== undefined && Number(rec.amount) < minAmount) continue;

      const event: SettlementEvent = {
        anchorId,
        chain: this.chain,
        asset: assetCode(rec.asset),
        direction: isInbound ? "deposit" : "withdrawal",
        amount: rec.amount,
        onchainRef: rec.txHash,
        fiatLegRef: null,
        evidenceTier: this.maxTier,
        evidenceDetail: "stellar_ledger",
        // Stellar IS the keystone — a native settlement here doesn't root to
        // anything else. keystoneRef is for other chains' adapters to fill
        // in when their event touches Stellar (e.g. a CCTP mint here).
        keystoneRef: null,
        observedAt: rec.createdAt,
      };
      yield event;
    }
  }

  /**
   * What "PROVEN" cashes out to: re-reads the transaction straight from
   * Horizon and confirms it exists and succeeded. Anyone can run this same
   * check against the public ledger — verification never depends on
   * trusting Landfall's own record of the event.
   */
  async verify(ev: SettlementEvent): Promise<boolean> {
    if (ev.chain !== this.chain) return false;
    const url = `${this.horizon.replace(/\/$/, "")}/transactions/${ev.onchainRef}`;
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as Record<string, unknown>;
      return body["successful"] === true;
    } catch {
      return false;
    }
  }
}
