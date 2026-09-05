import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * The maintained, hand-curated part of anchor identity (MULTICHAIN.md §5,
 * step 3). Stellar accounts are resolved live from SEP-1 (identity.ts) —
 * there is no equivalent standard field for an anchor's addresses on other
 * chains, so those have to be recorded here by whoever verified them.
 */
const ChainAddresses = z.object({
  addresses: z.array(z.string().min(1)).min(1),
});

const AnchorRegistryEntry = z.object({
  chains: z.record(z.string(), ChainAddresses),
});

export const AnchorsRegistry = z.object({
  version: z.literal(1),
  anchors: z.record(z.string(), AnchorRegistryEntry),
});
export type AnchorsRegistry = z.infer<typeof AnchorsRegistry>;

/** Throws a descriptive error on malformed JSON or a schema violation — a corrupt registry must not silently resolve to "no addresses". */
export function parseAnchorsRegistry(raw: string): AnchorsRegistry {
  return AnchorsRegistry.parse(JSON.parse(raw));
}

export async function loadAnchorsRegistry(filePath: string): Promise<AnchorsRegistry> {
  const raw = await readFile(filePath, "utf8");
  return parseAnchorsRegistry(raw);
}

/** Curated addresses for `anchorId` on `chain`, or [] if none have been recorded yet — absence here is "not yet curated," not "confirmed zero presence." */
export function lookupCrossChainAddresses(
  registry: AnchorsRegistry,
  anchorId: string,
  chain: string,
): string[] {
  return registry.anchors[anchorId]?.chains[chain]?.addresses ?? [];
}
