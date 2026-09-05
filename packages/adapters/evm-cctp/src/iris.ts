export interface IrisMessage {
  attestation: string | null;
  message: string;
  eventNonce?: string;
  status?: string;
}

/**
 * Looks up a burn's message + attestation by transaction hash, via
 * `GET /v1/messages/{sourceDomainId}/{transactionHash}` — Circle's Iris
 * API. Looking up by tx hash rather than by message hash avoids needing an
 * independent re-implementation of Circle's message-hash encoding just to
 * ask about a transaction we already have the hash for.
 *
 * https://developers.circle.com/api-reference/stablecoins/common/get-messages
 */
export async function fetchMessagesForTx(params: {
  irisApiBase: string;
  sourceDomainId: number;
  transactionHash: string;
  fetchImpl?: typeof fetch;
}): Promise<IrisMessage[]> {
  const { irisApiBase, sourceDomainId, transactionHash, fetchImpl = fetch } = params;
  const url = `${irisApiBase.replace(/\/$/, "")}/v1/messages/${sourceDomainId}/${transactionHash}`;
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  // No message yet for this tx (still indexing) reads the same as "nothing
  // found here" — the caller's job, not treated as an error.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Iris ${res.status} for ${url}`);
  const body = (await res.json()) as { messages?: IrisMessage[] };
  return body.messages ?? [];
}

/**
 * Whether Circle's attester has actually signed off. `status` is the
 * documented field ("complete" vs "pending_confirmations"); a present,
 * non-empty `attestation` is treated as the same signal for API variants
 * that omit `status`, rather than trusting either field alone.
 */
export function isAttestationComplete(message: IrisMessage): boolean {
  if (message.status) return message.status === "complete";
  return typeof message.attestation === "string" && message.attestation.length > 0;
}
