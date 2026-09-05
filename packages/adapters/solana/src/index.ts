import { NULL_FIAT_LEG_BINDER, type FiatLegProofBinder } from "./fiatProof.js";
import { mintSymbol } from "./mints.js";
import { getSignaturesForAddress, getTokenBalanceDelta, transactionSucceeded } from "./rpc.js";
import { formatTokenAmount, parseTokenAmount } from "./units.js";
import type { ChainAdapter, EvidenceTier, ScanOpts, SettlementEvent } from "../../src/types.js";

export { NULL_FIAT_LEG_BINDER } from "./fiatProof.js";
export type { FiatLegProof, FiatLegProofBinder, FiatLegProofKind } from "./fiatProof.js";
export { KNOWN_MINTS } from "./mints.js";

export interface SolanaAdapterOptions {
  chain?: string;
  rpcUrl?: string;
  /** Decimals to interpret ScanOpts.minAmount against — must match the mint being scanned. Defaults to 6 (USDC/USDT). */
  minAmountDecimals?: number;
  /** Upgrades a bare balance change into DERIVED evidence. Defaults to NULL_FIAT_LEG_BINDER, which binds nothing. */
  fiatLegProofBinder?: FiatLegProofBinder;
  fetchImpl?: typeof fetch;
}

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Solana adapter (MULTICHAIN.md §6.4). maxTier: DERIVED — an SPL balance
 * change is visible and independently verifiable, but (as with Tron) the
 * fiat leg behind it is custodial. scan() only emits an event once its
 * `fiatLegProofBinder` has bound an off-chain proof to that balance change;
 * the default binder binds nothing, so out of the box this adapter emits
 * nothing — the same rule the Tron and evm-cctp adapters apply to evidence
 * that hasn't actually been earned yet.
 *
 * `anchorId` is a specific SPL token account address (the anchor's ATA for
 * one mint) — not the anchor's wallet address. A wallet's own pubkey often
 * isn't a key in a transaction that credits it (only its token account
 * is), so scanning the wallet address would silently miss inbound
 * transfers; scanning the token account directly is what makes both
 * directions actually detectable. This mirrors the other adapters'
 * "raw chain address for now" stopgap ahead of SEP-1-driven resolution
 * (`@landfall/registry`) — an anchor with both USDC and USDT presence is
 * scanned as two separate token accounts, one call each.
 */
export class SolanaAdapter implements ChainAdapter {
  readonly chain: string;
  readonly maxTier: EvidenceTier = "DERIVED";

  private readonly rpcUrl: string;
  private readonly minAmountDecimals: number;
  private readonly fiatLegProofBinder: FiatLegProofBinder;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SolanaAdapterOptions = {}) {
    this.chain = options.chain ?? "solana";
    this.rpcUrl = options.rpcUrl ?? DEFAULT_RPC;
    this.minAmountDecimals = options.minAmountDecimals ?? 6;
    this.fiatLegProofBinder = options.fiatLegProofBinder ?? NULL_FIAT_LEG_BINDER;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *scan(anchorId: string, opts: ScanOpts = {}): AsyncIterable<SettlementEvent> {
    if (opts.toLedgerOrBlock !== undefined) {
      throw new Error(
        "SolanaAdapter.scan: toLedgerOrBlock is not implemented — signature paging here has no upper bound yet.",
      );
    }
    const { stopAtSlot, stopAtBlockTime } = toStopBoundary(opts.fromLedgerOrBlock);
    const minAmount =
      opts.minAmount !== undefined ? parseTokenAmount(opts.minAmount, this.minAmountDecimals) : undefined;

    const signatures = await getSignaturesForAddress({
      rpcUrl: this.rpcUrl,
      address: anchorId,
      stopAtSlot,
      stopAtBlockTime,
      fetchImpl: this.fetchImpl,
    });

    for (const sig of signatures) {
      // Solana transactions are atomic — a failed one moved no token
      // balances, so it's skipped before spending an RPC call on it.
      if (sig.err !== null) continue;

      const change = await getTokenBalanceDelta({
        rpcUrl: this.rpcUrl,
        signature: sig.signature,
        tokenAccount: anchorId,
        fetchImpl: this.fetchImpl,
      });
      if (!change) continue;

      const absDelta = change.delta < 0n ? -change.delta : change.delta;
      if (minAmount !== undefined && absDelta < minAmount) continue;

      const proof = await this.fiatLegProofBinder.bind(change);
      if (!proof) continue;

      const event: SettlementEvent = {
        anchorId,
        chain: this.chain,
        asset: mintSymbol(change.mint),
        direction: change.delta > 0n ? "deposit" : "withdrawal",
        amount: formatTokenAmount(absDelta, change.decimals),
        onchainRef: change.signature,
        fiatLegRef: proof.ref,
        evidenceTier: this.maxTier,
        evidenceDetail: `solana_transfer+${proof.kind}`,
        keystoneRef: null,
        observedAt: change.observedAt,
      };
      yield event;
    }
  }

  /**
   * Re-confirms the on-chain half independently. Like the Tron adapter,
   * this cannot and does not re-verify the bound off-chain proof itself —
   * that is the proof provider's job.
   */
  async verify(ev: SettlementEvent): Promise<boolean> {
    if (ev.chain !== this.chain) return false;
    try {
      return await transactionSucceeded({
        rpcUrl: this.rpcUrl,
        signature: ev.onchainRef,
        fetchImpl: this.fetchImpl,
      });
    } catch {
      return false;
    }
  }
}

function toStopBoundary(value: number | string | undefined): { stopAtSlot?: number; stopAtBlockTime?: number } {
  if (value === undefined) return {};
  if (typeof value === "number") return { stopAtSlot: value };
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`SolanaAdapter.scan: fromLedgerOrBlock string must be an ISO-8601 date, got "${value}"`);
  }
  return { stopAtBlockTime: Math.floor(parsed / 1000) };
}
