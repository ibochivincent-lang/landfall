/**
 * cross-chain-scan.ts
 *
 * Runs the cross-chain settlement scan (docs/architecture/MULTICHAIN.md) for
 * every tracked anchor and writes the artifact the site reads:
 *
 *   packages/web/api/v1/cross-chain.json
 *
 * Called by .github/workflows/scan.yml after the hourly ledger scan.
 * Manual run:  npx tsx scripts/cross-chain-scan.ts
 *
 * What it actually does, and what it deliberately doesn't:
 *
 *  - Stellar (keystone, PROVEN) is scanned for real, per declared account,
 *    off the public ledger. Those numbers are measurements.
 *  - Every other chain is only scanned when an address for that anchor has
 *    been curated in registry/anchors.registry.json AND the chain has CCTP
 *    wiring in registry/cctp.deployments.json. Both ship empty, so those
 *    chains report as `unresolved` with the reason attached. That is the
 *    honest state of cross-chain coverage today — it is not the same claim
 *    as "this anchor did nothing on Base", and the artifact keeps the two
 *    distinguishable so the site can too.
 *  - Attestations are signed only when STP_SIGNING_KEY is set. Without it
 *    they carry a reproducible SHA-256 digest and `signed: false`, because a
 *    signature from a throwaway key would prove nothing to anyone.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StellarAdapter } from "../packages/adapters/stellar/src/index.js";
import { EvmCctpAdapter } from "../packages/adapters/evm-cctp/src/index.js";
import { TronAdapter } from "../packages/adapters/tron/src/index.js";
import { SolanaAdapter } from "../packages/adapters/solana/src/index.js";
import type { ChainAdapter, EvidenceTier } from "../packages/adapters/src/types.js";
import {
  parseAnchorsRegistry,
  resolveAnchorIdentity,
  lookupCrossChainAddresses,
  type AnchorsRegistry,
} from "../packages/registry/src/index.js";
import {
  crossChainScan,
  pickAnchor,
  type AdapterSource,
  type AnchorCandidate,
  type UnresolvedChain,
} from "../packages/sdk/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ANCHORS_JSON = join(ROOT, "packages", "web", "api", "v1", "anchors.json");
const REGISTRY_JSON = join(ROOT, "registry", "anchors.registry.json");
const CCTP_JSON = join(ROOT, "registry", "cctp.deployments.json");
const OUT_FILE = join(ROOT, "packages", "web", "api", "v1", "cross-chain.json");

const HORIZON = process.env.HORIZON_URL || "https://horizon.stellar.org";
const WINDOW_DAYS = Number(process.env.CROSS_CHAIN_WINDOW_DAYS || 30);
const MAX_RECORDS = Number(process.env.CROSS_CHAIN_MAX_RECORDS || 200);
const SIGNER = process.env.STP_SIGNER_ID || "landfall-attester-dev";
const SIGNING_KEY = process.env.STP_SIGNING_KEY || undefined;
const SAMPLE_ATTESTATIONS = 3;

/** Chains the spec names, with the tier each adapter can reach (MULTICHAIN.md §6). */
const CHAINS_IN_SCOPE: ReadonlyArray<{ chain: string; maxTier: EvidenceTier; kind: "evm-cctp" | "tron" | "solana" }> = [
  { chain: "ethereum", maxTier: "ATTESTED", kind: "evm-cctp" },
  { chain: "base", maxTier: "ATTESTED", kind: "evm-cctp" },
  { chain: "arbitrum", maxTier: "ATTESTED", kind: "evm-cctp" },
  { chain: "optimism", maxTier: "ATTESTED", kind: "evm-cctp" },
  { chain: "polygon", maxTier: "ATTESTED", kind: "evm-cctp" },
  { chain: "tron", maxTier: "DERIVED", kind: "tron" },
  { chain: "solana", maxTier: "DERIVED", kind: "solana" },
];

interface CctpDeployment {
  domainId: number;
  tokenMessenger: string;
  rpcUrl?: string;
}

interface CctpDeployments {
  version: number;
  deployments: Record<string, CctpDeployment>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/**
 * Stellar accounts for an anchor, resolved from SEP-1 where the domain's
 * stellar.toml is reachable, and from the last committed ledger scan when it
 * isn't. Which source was used is recorded in the artifact — a fallback that
 * doesn't say it fell back is just a quieter kind of wrong.
 */
async function resolveStellarAccounts(
  domain: string,
  priorAccounts: string[],
): Promise<{ accounts: string[]; identitySource: "sep1" | "prior-scan"; note?: string }> {
  try {
    const identity = await resolveAnchorIdentity(domain, fetch, HORIZON);
    if (!identity.error && identity.stellarAccounts.length > 0) {
      return {
        accounts: identity.stellarAccounts.map((a) => a.account),
        identitySource: "sep1",
      };
    }
    return {
      accounts: priorAccounts,
      identitySource: "prior-scan",
      note: identity.error
        ? `SEP-1 lookup failed (${identity.error}); using accounts from the last committed ledger scan`
        : "SEP-1 declared no accounts; using accounts from the last committed ledger scan",
    };
  } catch (err) {
    return {
      accounts: priorAccounts,
      identitySource: "prior-scan",
      note: `SEP-1 lookup threw (${err instanceof Error ? err.message : String(err)}); using accounts from the last committed ledger scan`,
    };
  }
}

/** Builds a non-Stellar adapter for a curated address, or explains why it can't. */
function buildAdapter(
  spec: (typeof CHAINS_IN_SCOPE)[number],
  cctp: CctpDeployments,
): { adapter: ChainAdapter } | { reason: string } {
  if (spec.kind === "tron") return { adapter: new TronAdapter({ chain: "tron" }) };
  if (spec.kind === "solana") return { adapter: new SolanaAdapter({ chain: "solana" }) };

  const deployment = cctp.deployments[spec.chain];
  if (!deployment) {
    return { reason: `no CCTP deployment configured for ${spec.chain} in registry/cctp.deployments.json` };
  }
  if (!deployment.rpcUrl) {
    return { reason: `CCTP deployment for ${spec.chain} has no rpcUrl configured` };
  }
  return {
    adapter: new EvmCctpAdapter({
      chain: spec.chain,
      rpcUrl: deployment.rpcUrl,
      tokenMessengerAddress: deployment.tokenMessenger,
      sourceDomainId: deployment.domainId,
    }),
  };
}

async function main(): Promise<void> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  const prior = await readJson<{ asOf: string; accounts: Array<{ domain: string; account: string }> }>(ANCHORS_JSON);
  const registry: AnchorsRegistry = parseAnchorsRegistry(await readFile(REGISTRY_JSON, "utf8"));
  const cctp = await readJson<CctpDeployments>(CCTP_JSON);

  const priorByDomain = new Map<string, string[]>();
  for (const row of prior.accounts) {
    if (!priorByDomain.has(row.domain)) priorByDomain.set(row.domain, []);
    priorByDomain.get(row.domain)!.push(row.account);
  }

  const stellar = new StellarAdapter({ horizon: HORIZON, maxRecords: MAX_RECORDS });
  const anchors: unknown[] = [];
  const candidates: AnchorCandidate[] = [];
  const totals: Record<EvidenceTier, number> = { PROVEN: 0, ATTESTED: 0, DERIVED: 0 };

  for (const [domain, priorAccounts] of [...priorByDomain.entries()].sort()) {
    process.stdout.write(`scanning ${domain} … `);

    const identity = await resolveStellarAccounts(domain, priorAccounts);
    const sources: AdapterSource[] = identity.accounts.map((account) => ({ adapter: stellar, address: account }));
    const unresolved: UnresolvedChain[] = [];

    for (const spec of CHAINS_IN_SCOPE) {
      const addresses = lookupCrossChainAddresses(registry, domain, spec.chain);
      if (addresses.length === 0) {
        unresolved.push({
          chain: spec.chain,
          maxTier: spec.maxTier,
          reason: `no ${spec.chain} address curated for this anchor in registry/anchors.registry.json`,
        });
        continue;
      }
      const built = buildAdapter(spec, cctp);
      if ("reason" in built) {
        unresolved.push({ chain: spec.chain, maxTier: spec.maxTier, reason: built.reason });
        continue;
      }
      for (const address of addresses) sources.push({ adapter: built.adapter, address });
    }

    const result = await crossChainScan({
      anchorId: domain,
      sources,
      unresolved,
      scanOpts: { fromLedgerOrBlock: since },
      attestation: { signer: SIGNER, privateKeyB64: SIGNING_KEY },
    });

    for (const tier of result.summary.tiers) totals[tier.tier] += tier.events;
    candidates.push({ anchorId: domain, summary: result.summary });

    anchors.push({
      anchorId: domain,
      identitySource: identity.identitySource,
      identityNote: identity.note,
      stellarAccounts: identity.accounts,
      summary: result.summary,
      failures: result.failures,
      sampleAttestations: result.attestations.slice(0, SAMPLE_ATTESTATIONS),
    });

    console.log(`${result.summary.tierMix}${result.failures.length ? ` (${result.failures.length} failure(s))` : ""}`);
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    stpVersion: "1",
    window: { since, days: WINDOW_DAYS, maxRecordsPerAccount: MAX_RECORDS },
    keystoneChain: "stellar",
    attester: {
      signer: SIGNER,
      signed: Boolean(SIGNING_KEY),
      note: SIGNING_KEY
        ? "Attestations are Ed25519-signed. Verify with the published attester public key."
        : "STP_SIGNING_KEY is not configured, so attestations ship unsigned. Each still carries a SHA-256 digest of its canonical serialization, which anyone can recompute from the attestation body — it just isn't attributable to Landfall.",
    },
    chainsInScope: [
      { chain: "stellar", maxTier: "PROVEN" as EvidenceTier, adapter: "@landfall/adapter-stellar" },
      ...CHAINS_IN_SCOPE.map((c) => ({
        chain: c.chain,
        maxTier: c.maxTier,
        adapter: c.kind === "evm-cctp" ? "@landfall/adapter-evm-cctp" : `@landfall/adapter-${c.kind}`,
      })),
    ],
    totals,
    ranked: pickAnchor(candidates),
    anchors,
  };

  await writeFile(OUT_FILE, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log(
    `\nWrote ${OUT_FILE}\n  PROVEN ${totals.PROVEN} · ATTESTED ${totals.ATTESTED} · DERIVED ${totals.DERIVED}`,
  );
}

main().catch((err) => {
  console.error("cross-chain scan failed:", err);
  process.exit(1);
});
