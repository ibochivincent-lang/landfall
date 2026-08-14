import type { AnchorAccount } from "./types.js";

/**
 * Minimal SEP-1 stellar.toml reader.
 *
 * We deliberately do not pull a full TOML parser. We need exactly three
 * things: the ACCOUNTS array, the issuer of each [[CURRENCIES]] block, and
 * the organisation name. Parsing only that keeps the dependency count at
 * zero and the failure surface small.
 */

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;

export function isStellarAccount(value: string): boolean {
  return STELLAR_ACCOUNT.test(value);
}

/** Strip comments and surrounding quotes from a raw TOML value. */
function clean(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, "").trim();
  return withoutComment.replace(/^["']/, "").replace(/["']$/, "");
}

export interface ParsedToml {
  name?: string;
  accounts: string[];
  issuers: string[];
}

export function parseStellarToml(text: string): ParsedToml {
  const lines = text.split(/\r?\n/);
  const accounts = new Set<string>();
  const issuers = new Set<string>();
  let name: string | undefined;

  let inAccountsArray = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Multi-line ACCOUNTS = [ ... ]
    if (inAccountsArray) {
      for (const m of trimmed.matchAll(/G[A-Z2-7]{55}/g)) accounts.add(m[0]);
      if (trimmed.includes("]")) inAccountsArray = false;
      continue;
    }

    if (/^ACCOUNTS\s*=/.test(trimmed)) {
      for (const m of trimmed.matchAll(/G[A-Z2-7]{55}/g)) accounts.add(m[0]);
      // Array left open — keep consuming until the closing bracket.
      if (trimmed.includes("[") && !trimmed.includes("]")) inAccountsArray = true;
      continue;
    }

    const issuerMatch = /^issuer\s*=\s*(.+)$/i.exec(trimmed);
    if (issuerMatch?.[1]) {
      const value = clean(issuerMatch[1]);
      if (isStellarAccount(value)) issuers.add(value);
      continue;
    }

    if (!name) {
      const nameMatch = /^ORG_NAME\s*=\s*(.+)$/i.exec(trimmed);
      if (nameMatch?.[1]) name = clean(nameMatch[1]);
    }
  }

  return { name, accounts: [...accounts], issuers: [...issuers] };
}

/**
 * Fetch and parse a domain's stellar.toml, returning every account it declares.
 * Returns an empty list rather than throwing — a domain being unreachable is
 * itself a finding, not a crash.
 */
export async function discoverDomain(
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accounts: AnchorAccount[]; error?: string }> {
  const url = `https://${domain}/.well-known/stellar.toml`;
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { accounts: [], error: `HTTP ${res.status}` };

    const parsed = parseStellarToml(await res.text());
    const seen = new Set<string>();
    const accounts: AnchorAccount[] = [];

    for (const account of parsed.accounts) {
      if (seen.has(account)) continue;
      seen.add(account);
      accounts.push({ domain, name: parsed.name, account, role: "declared" });
    }
    for (const account of parsed.issuers) {
      if (seen.has(account)) continue;
      seen.add(account);
      accounts.push({ domain, name: parsed.name, account, role: "issuer" });
    }

    return { accounts };
  } catch (err) {
    return { accounts: [], error: err instanceof Error ? err.message : String(err) };
  }
}
