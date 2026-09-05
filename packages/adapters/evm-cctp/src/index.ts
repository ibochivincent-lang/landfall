import { TOPIC0_DEPOSIT_FOR_BURN, decodeDepositForBurnLog, encodeAddressTopic } from "./abi.js";
import { fetchMessagesForTx, isAttestationComplete } from "./iris.js";
import { ethGetBlockTimestamps, ethGetLogs } from "./rpc.js";
import { formatUsdcAmount } from "./units.js";
import type { ChainAdapter, EvidenceTier, ScanOpts, SettlementEvent } from "../../src/types.js";

export { CCTP_DOMAIN_IDS } from "./constants.js";

export interface EvmCctpAdapterOptions {
  /** STP chain id this adapter reports events as, e.g. "base", "arbitrum". */
  chain: string;
  rpcUrl: string;
  /** TokenMessenger contract address on `chain`. */
  tokenMessengerAddress: string;
  /** This chain's Circle CCTP domain id. See ./constants.ts. */
  sourceDomainId: number;
  irisApiBase?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_IRIS_API = "https://iris-api.circle.com";

/**
 * EVM CCTP adapter (MULTICHAIN.md §6.2). maxTier: ATTESTED — a burn alone
 * is just a transfer; what makes it ATTESTED evidence is Circle's Iris
 * attestation actually being signed, so scan() only emits an event once
 * that attestation is complete. A burn still waiting on confirmations is
 * not reported yet, rather than reported under a tier it hasn't earned.
 *
 * `anchorId` is the depositor's EVM address (0x...) for now — as with the
 * Stellar adapter, SEP-1 identity resolution (MULTICHAIN.md §5) isn't
 * wired up yet.
 *
 * Only detects the burn side (`bridge_out`). Confirming the completing
 * mint on the destination chain — and populating `keystoneRef` when that
 * destination is Stellar — needs the destination adapter's own scan
 * reconciled against this one; that reconciliation belongs to the L2/L3
 * layer that reads multiple adapters together, not to a single adapter.
 */
export class EvmCctpAdapter implements ChainAdapter {
  readonly chain: string;
  readonly maxTier: EvidenceTier = "ATTESTED";

  private readonly rpcUrl: string;
  private readonly tokenMessengerAddress: string;
  private readonly sourceDomainId: number;
  private readonly irisApiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EvmCctpAdapterOptions) {
    this.chain = options.chain;
    this.rpcUrl = options.rpcUrl;
    this.tokenMessengerAddress = options.tokenMessengerAddress;
    this.sourceDomainId = options.sourceDomainId;
    this.irisApiBase = options.irisApiBase ?? DEFAULT_IRIS_API;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *scan(anchorId: string, opts: ScanOpts = {}): AsyncIterable<SettlementEvent> {
    const fromBlock = toBlockTag(opts.fromLedgerOrBlock, "earliest");
    const toBlock = toBlockTag(opts.toLedgerOrBlock, "latest");
    const minAmountBaseUnits =
      opts.minAmount !== undefined ? parseUsdcToBaseUnits(opts.minAmount) : undefined;

    const logs = await ethGetLogs({
      rpcUrl: this.rpcUrl,
      address: this.tokenMessengerAddress,
      // depositor is the 3rd indexed param -> topics[3]; nonce/burnToken (topics[1..2]) are left as wildcards.
      topics: [TOPIC0_DEPOSIT_FOR_BURN, null, null, encodeAddressTopic(anchorId)],
      fromBlock,
      toBlock,
      fetchImpl: this.fetchImpl,
    });
    if (logs.length === 0) return;

    const timestamps = await ethGetBlockTimestamps({
      rpcUrl: this.rpcUrl,
      blockNumbers: logs.map((l) => l.blockNumber),
      fetchImpl: this.fetchImpl,
    });

    for (const log of logs) {
      const burn = decodeDepositForBurnLog(log);
      if (minAmountBaseUnits !== undefined && burn.amount < minAmountBaseUnits) continue;

      const messages = await fetchMessagesForTx({
        irisApiBase: this.irisApiBase,
        sourceDomainId: this.sourceDomainId,
        transactionHash: log.transactionHash,
        fetchImpl: this.fetchImpl,
      });
      if (!messages.some(isAttestationComplete)) continue;

      const observedAt = timestamps.get(log.blockNumber);
      if (!observedAt) {
        throw new Error(
          `no block timestamp resolved for block ${log.blockNumber} (tx ${log.transactionHash})`,
        );
      }

      const event: SettlementEvent = {
        anchorId,
        chain: this.chain,
        // CCTP burns USDC by construction, not inferred from burnToken.
        asset: "USDC",
        direction: "bridge_out",
        amount: formatUsdcAmount(burn.amount),
        onchainRef: log.transactionHash,
        fiatLegRef: null,
        evidenceTier: this.maxTier,
        evidenceDetail: "cctp_burn+iris",
        keystoneRef: null,
        observedAt,
      };
      yield event;
    }
  }

  /**
   * Re-checks Circle's attestation for this event's transaction directly,
   * rather than trusting that scan() classified it correctly.
   */
  async verify(ev: SettlementEvent): Promise<boolean> {
    if (ev.chain !== this.chain) return false;
    try {
      const messages = await fetchMessagesForTx({
        irisApiBase: this.irisApiBase,
        sourceDomainId: this.sourceDomainId,
        transactionHash: ev.onchainRef,
        fetchImpl: this.fetchImpl,
      });
      return messages.some(isAttestationComplete);
    } catch {
      return false;
    }
  }
}

function toBlockTag(value: number | string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return typeof value === "number" ? "0x" + value.toString(16) : value;
}

function parseUsdcToBaseUnits(decimalAmount: string): bigint {
  const [whole, frac = ""] = decimalAmount.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0");
}
