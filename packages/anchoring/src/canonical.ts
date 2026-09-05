/**
 * Canonical serialization for structured records (RFC 8785, JCS).
 *
 * The standard says records are bytes. Real users anchor objects, and that is
 * where a scheme like this quietly breaks: `{"a":1,"b":2}` and `{"b":2,"a":1}`
 * are the same record and hash differently. A verifier re-serialising with a
 * different library, language or key order gets a different leaf and concludes
 * the document was tampered with. The proof was fine; the encoding was not.
 *
 * That failure is worse than an ordinary bug because it appears years later,
 * looks exactly like fraud, and the party who can least afford it — the one
 * holding a valid document — is the one it accuses.
 *
 * So: canonicalise before hashing, always, and reject anything that cannot be
 * canonicalised rather than serialising it approximately.
 *
 * This implements RFC 8785. JSON.stringify already does the hard parts —
 * ECMAScript number-to-string and JSON string escaping are exactly what JCS
 * specifies — so what is added here is recursive key ordering and refusing the
 * values JSON.stringify would mangle in silence.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Values JSON.stringify handles by quietly producing something wrong.
 *
 * Each of these has a plausible-looking output that does not round-trip:
 * NaN and Infinity become `null`, `undefined` inside an object vanishes along
 * with its key, and a bigint throws only sometimes depending on context. A
 * record that silently loses a field is a record whose hash commits to
 * something the author did not intend.
 */
function assertCanonicalisable(value: unknown, path: string): void {
  if (value === null) return;

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `Cannot canonicalise ${String(value)} at ${path}: JSON has no representation for it and ` +
            `JSON.stringify would silently emit null, committing to a value you did not write.`,
        );
      }
      return;
    case "bigint":
      throw new Error(
        `Cannot canonicalise a bigint at ${path}. JSON numbers are doubles; serialise it as a string ` +
          `and document the units, rather than losing precision inside a hash.`,
      );
    case "undefined":
      throw new Error(
        `Cannot canonicalise undefined at ${path}. JSON.stringify would drop the key entirely, so the ` +
          `hash would commit to a record with a field missing.`,
      );
    case "function":
    case "symbol":
      throw new Error(`Cannot canonicalise a ${typeof value} at ${path}.`);
    case "object":
      break;
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCanonicalisable(v, `${path}[${i}]`));
    return;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Date, Map, Set, class instances: each has a toJSON or a default that
    // loses information. Requiring plain objects makes the author decide how
    // their type is represented, rather than the serialiser deciding silently.
    throw new Error(
      `Cannot canonicalise a non-plain object at ${path} (${proto?.constructor?.name ?? "unknown"}). ` +
        `Convert it to plain JSON values first, so the representation is your decision and not the ` +
        `serialiser's.`,
    );
  }

  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    assertCanonicalisable(v, `${path}.${key}`);
  }
}

/**
 * RFC 8785 canonical JSON.
 *
 * Keys are sorted by UTF-16 code unit, which is JavaScript's default string
 * comparison and is what JCS specifies — not locale-aware collation, which
 * would differ between machines.
 */
function canonicalise(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k] as JsonValue)}`).join(",")}}`;
}

/**
 * Canonical JSON string for a record.
 *
 * Validate first, serialise second, so an unrepresentable value produces an
 * error naming the field rather than a hash over silently mangled data.
 */
export function canonicalJson(value: JsonValue): string {
  assertCanonicalisable(value, "$");
  return canonicalise(value);
}

/**
 * A structured record as the bytes to anchor.
 *
 * This is what should be passed to `buildAnchor` for anything that is not
 * already an opaque blob. Pair it with `canonicalJson` on the verifier's side
 * and the encoding stops being a source of false tampering alarms.
 */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/**
 * Do two structurally different-looking records canonicalise identically?
 *
 * Useful in a verifier that wants to explain *why* a document did not match:
 * "your JSON is ordered differently but is the same record" is a very
 * different message from "this is not the anchored document".
 */
export function canonicallyEqual(a: JsonValue, b: JsonValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
