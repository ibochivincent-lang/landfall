/**
 * Deterministic JSON serialization: object keys sorted recursively, so the
 * same attestation always produces the same byte string regardless of the
 * key order it was constructed in. This is what makes signatures
 * reproducible across languages/adapters (MULTICHAIN.md §3 design rules).
 *
 * Not a general JCS (RFC 8785) implementation — STP attestations are flat
 * objects of strings/null, which is all this needs to handle correctly.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
