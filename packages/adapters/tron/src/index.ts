import { NULL_FIAT_LEG_BINDER, type FiatLegProofBinder } from "./fiatProof.js";
import { fetchTransactionSucceeded, fetchTrc20Transfers, type Trc20Transfer } from "./trongrid.js";
import { formatTokenAmount, parseTokenAmount } from "./units.js";
import type { ChainAdapter, EvidenceTier, ScanOpts, SettlementEvent } from "../../src/types.js";

export { NULL_FIAT_LEG_BINDER } from "./fiatProof.js";
export type { FiatLegProof, FiatLegProofBinder, FiatLegProofKind } from "./fiatProof.js";

/** https://tronscan.org/#/contract/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/code — the canonical USDT-TRC20 contract. */
export const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

export interface TronAdapterOptions {
  chain?: string;
  apiBase?: string;
  usdtContractAddress?: string;
  /** Upgrades a bare transfer into DERIVED evidence. Defaults to NULL_FIAT_LEG_BINDER, which binds nothing. */
  fiatLegProofBinder?: FiatLegProofBinder;
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_BASE = "https://api.trongrid.io";

/**
 * Tron adapter (MULTICHAIN.md §6.3). maxTier: DERIVED — a TRC20 transfer is
 * visible and independently verifiable on its own, but the fiat leg behind
 * it is custodial, so what it actually settled can't be read off the
 * ledger the way it can on Stellar. scan() only emits an event once its
 * `fiatLegProofBinder` has bound an off-chain proof to that transfer; the
 * default binder binds nothing, so out of the box this adapter emits
 * nothing rather than present a bare transfer as evidence it hasn't
 * earned — the same rule the evm-cctp adapter applies to unconfirmed
 * burns.
 *
 * `anchorId` is a Tron address (T...) directly, as with the other
 * adapters, pending SEP-1-driven cross-chain resolution
 * (`@landfall/registry`).
 */
export class TronAdapter implements ChainAdapter {
  readonly chain: string;
  readonly maxTier: EvidenceTier = "DERIVED";

  private readonly apiBase: string;
  private readonly usdtContractAddress: string;
  private readonly fiatLegProofBinder: FiatLegProofBinder;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TronAdapterOptions = {}) {
    this.chain = options.chain ?? "tron";
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.usdtContractAddress = options.usdtContractAddress ?? USDT_TRC20_CONTRACT;
    this.fiatLegProofBinder = options.fiatLegProofBinder ?? NULL_FIAT_LEG_BINDER;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *scan(anchorId: string, opts: ScanOpts = {}): AsyncIterable<SettlementEvent> {
    if (opts.toLedgerOrBlock !== undefined) {
      throw new Error(
        "TronAdapter.scan: toLedgerOrBlock is not implemented — TronGrid paging here has no upper bound yet.",
      );
    }
    const minTimestampMs = toMinTimestampMs(opts.fromLedgerOrBlock);
    const minAmount = opts.minAmount !== undefined ? parseTokenAmount(opts.minAmount, 6) : undefined;

    const [inbound, outbound] = await Promise.all([
      fetchTrc20Transfers({
        apiBase: this.apiBase,
        address: anchorId,
        contractAddress: this.usdtContractAddress,
        onlyTo: true,
        minTimestampMs,
        fetchImpl: this.fetchImpl,
      }),
      fetchTrc20Transfers({
        apiBase: this.apiBase,
        address: anchorId,
        contractAddress: this.usdtContractAddress,
        onlyFrom: true,
        minTimestampMs,
        fetchImpl: this.fetchImpl,
      }),
    ]);

    const tagged: Array<{ transfer: Trc20Transfer; direction: "deposit" | "withdrawal" }> = [
      ...inbound.map((transfer) => ({ transfer, direction: "deposit" as const })),
      ...outbound.map((transfer) => ({ transfer, direction: "withdrawal" as const })),
    ];

    for (const { transfer, direction } of tagged) {
      if (minAmount !== undefined && transfer.value < minAmount) continue;

      // The one gate that decides whether this is reportable at all: no
      // bound proof means no DERIVED-tier claim, full stop.
      const proof = await this.fiatLegProofBinder.bind(transfer);
      if (!proof) continue;

      const event: SettlementEvent = {
        anchorId,
        chain: this.chain,
        asset: transfer.symbol,
        direction,
        amount: formatTokenAmount(transfer.value, transfer.decimals),
        onchainRef: transfer.transactionId,
        fiatLegRef: proof.ref,
        evidenceTier: this.maxTier,
        evidenceDetail: `tron_transfer+${proof.kind}`,
        keystoneRef: null,
        observedAt: transfer.observedAt,
      };
      yield event;
    }
  }

  /**
   * Re-confirms the on-chain half independently (the transaction really
   * succeeded on Tron). This does not and cannot re-verify the bound
   * off-chain proof itself — that is the proof provider's job, not this
   * adapter's; verify() only vouches for what an adapter can actually see.
   */
  async verify(ev: SettlementEvent): Promise<boolean> {
    if (ev.chain !== this.chain) return false;
    try {
      return await fetchTransactionSucceeded({
        apiBase: this.apiBase,
        transactionId: ev.onchainRef,
        fetchImpl: this.fetchImpl,
      });
    } catch {
      return false;
    }
  }
}

function toMinTimestampMs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`TronAdapter.scan: fromLedgerOrBlock must be an ISO-8601 date or a ms timestamp, got "${value}"`);
  }
  return parsed;
}
