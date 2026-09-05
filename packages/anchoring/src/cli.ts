/**
 * anchoring CLI — build an anchor, and verify one, from the command line.
 *
 *   npx tsx packages/anchoring/src/cli.ts anchor  --namespace certs  <file>...
 *   npx tsx packages/anchoring/src/cli.ts prove   --tree tree.json --index 2 \
 *       --ledger 55123456 --tx <hash> --close-time 2026-09-05T10:00:00Z
 *   npx tsx packages/anchoring/src/cli.ts verify  bundle.json [--document file]
 *   npx tsx packages/anchoring/src/cli.ts memo    <root-hex>
 *
 * `anchor` and `prove` are split on purpose. Building the tree needs the
 * documents; producing a bundle needs the ledger coordinate, which only exists
 * after a transaction has been submitted. Forcing them into one command would
 * mean this tool had to hold keys and submit transactions, which it
 * deliberately does not — see memo.ts.
 *
 * `verify` is the one that matters. It takes a bundle and nothing else, talks
 * only to a Horizon the caller names, and prints each check separately so a
 * network problem never reads as a failed proof.
 */

import { readFile, writeFile } from "node:fs/promises";

import { buildAnchor, type AnchorTree } from "./anchor.js";
import { buildBundle, parseBundle, serializeBundle, type LedgerCoordinate } from "./bundle.js";
import { rootToMemo } from "./memo.js";
import { fromHex, toHex } from "./merkle.js";
import { documentMatchesBundle, verifyBundle } from "./verify.js";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      i++; // skip its value
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Serialised tree, so `anchor` and `prove` can be separate invocations. */
interface TreeFile {
  record: AnchorTree["record"];
  leaves: string[];
}

async function cmdAnchor(argv: string[]): Promise<void> {
  const namespace = flag(argv, "namespace");
  const files = positionals(argv);
  if (!namespace) throw new Error("--namespace is required.");
  if (files.length === 0) throw new Error("Give at least one file to anchor.");

  const docs = await Promise.all(files.map((f) => readFile(f)));
  const tree = buildAnchor(
    namespace,
    docs.map((d) => new Uint8Array(d)),
    // Basenames only. A bundle is meant to be handed to strangers, and full
    // paths leak local directory structure and usernames into it for no
    // verification benefit — metadata never affects the root.
    { metadata: { files: files.map((f) => f.replace(/^.*[\\/]/, "")) } },
  );

  const out = flag(argv, "out") ?? "tree.json";
  const treeFile: TreeFile = { record: tree.record, leaves: tree.leaves.map(toHex) };
  await writeFile(out, JSON.stringify(treeFile, null, 2) + "\n", "utf8");

  const memo = rootToMemo(tree.record.root);
  console.log(`Anchored ${files.length} record(s) under namespace "${namespace}".`);
  console.log("");
  console.log(`  root         ${tree.record.root}`);
  console.log(`  count        ${tree.record.count}`);
  console.log(`  tree written ${out}`);
  console.log("");
  console.log("Next: submit any Stellar transaction carrying this memo.");
  console.log(`  memo_type    MEMO_HASH`);
  console.log(`  memo (b64)   ${memo.memoBase64}`);
  console.log("");
  console.log("Then run `prove` with the resulting ledger sequence and transaction hash.");
}

async function cmdProve(argv: string[]): Promise<void> {
  const treePath = flag(argv, "tree") ?? "tree.json";
  const indexRaw = flag(argv, "index");
  const sequence = Number(flag(argv, "ledger"));
  const txHash = flag(argv, "tx");
  const closeTime = flag(argv, "close-time");

  if (indexRaw === undefined) throw new Error("--index is required.");
  if (!Number.isInteger(sequence) || sequence <= 0) throw new Error("--ledger must be a ledger sequence.");
  if (!txHash) throw new Error("--tx is required.");
  if (!closeTime) throw new Error("--close-time is required (the ledger's close time, RFC 3339).");

  const treeFile = JSON.parse(await readFile(treePath, "utf8")) as TreeFile;
  const tree: AnchorTree = {
    record: treeFile.record,
    leaves: treeFile.leaves.map(fromHex),
    rootBytes: fromHex(treeFile.record.root),
  };

  const ledger: LedgerCoordinate = {
    sequence,
    closeTime,
    txHash,
    opIndex: Number(flag(argv, "op-index") ?? 0),
  };

  const bundle = buildBundle(tree, Number(indexRaw), ledger);
  const out = flag(argv, "out") ?? `bundle-${indexRaw}.json`;
  await writeFile(out, serializeBundle(bundle), "utf8");

  console.log(`Wrote ${out}`);
  console.log("This file is self-contained: anyone can verify it against any Horizon instance.");
}

async function cmdVerify(argv: string[]): Promise<void> {
  const [bundlePath] = positionals(argv);
  if (!bundlePath) throw new Error("Give a bundle file to verify.");

  const bundle = parseBundle(await readFile(bundlePath, "utf8"));
  const documentPath = flag(argv, "document");

  const result = await verifyBundle(bundle, {
    horizon: flag(argv, "horizon"),
    additionalArchives: flag(argv, "archives")?.split(",").filter(Boolean),
    offline: argv.includes("--offline"),
  });

  console.log(`Anchor  ${bundle.anchor.namespace} · root ${bundle.anchor.root.slice(0, 16)}…`);
  console.log(`Record  index ${bundle.record.index} of ${bundle.anchor.count}`);
  console.log("");

  for (const check of result.checks) {
    const mark = check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP";
    console.log(`  ${mark}  ${check.claim}`);
    if (check.detail) console.log(`        ${check.detail}`);
  }

  if (documentPath) {
    const doc = new Uint8Array(await readFile(documentPath));
    const match = documentMatchesBundle(doc, bundle);
    console.log("");
    console.log(`  ${match.matches ? "PASS" : "FAIL"}  The supplied document is the committed record.`);
    console.log(`        ${match.detail}`);
    if (!match.matches) process.exitCode = 1;
  } else {
    console.log("");
    console.log("  NOTE  No --document given, so this proves a hash was committed, not that");
    console.log("        any particular file produced it. Pass --document to bind the two.");
  }

  if (result.finality) {
    console.log("");
    console.log(`Finality  level ${result.finality.level} (${result.finality.name})`);
    console.log(`          ${result.finality.claim}`);
    console.log(`  limit   ${result.finality.limit}`);
  }
  if (result.committedNoLaterThan) {
    console.log("");
    console.log(`Committed no later than ${result.committedNoLaterThan} (ledger close time).`);
    console.log("This proves precedence, not creation — the data may be older, never newer.");
  }
  if (result.zk.unsupported) {
    console.log("");
    console.log(`ZK  ${result.zk.reason}`);
  }

  console.log("");
  console.log(result.verified ? "VERIFIED" : "NOT VERIFIED");
  if (!result.verified) process.exitCode = 1;
}

function cmdMemo(argv: string[]): void {
  const [root] = positionals(argv);
  if (!root) throw new Error("Give a root hex string.");
  const memo = rootToMemo(root);
  console.log(`memo_type  MEMO_HASH`);
  console.log(`memo       ${memo.memoBase64}`);
  console.log(`hex        ${memo.memoHex}`);
}

const USAGE = `stellar anchoring — cryptographic commitments on the Stellar ledger

  anchor --namespace <ns> [--out tree.json] <file>...
      Build a Merkle tree over files and print the MEMO_HASH to commit.

  prove --tree tree.json --index <n> --ledger <seq> --tx <hash>
        --close-time <rfc3339> [--op-index 0] [--out bundle.json]
      Turn a built tree plus a ledger coordinate into a proof bundle.

  verify <bundle.json> [--document <file>] [--horizon <url>]
         [--archives <url,url>] [--offline]
      Verify a bundle against any Horizon. Pass --document to bind a file
      to the committed hash.

  memo <root-hex>
      Print the MEMO_HASH for a root.

"Anchor" here means a cryptographic commitment, not a SEP-24 anchor.
`;

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "anchor":
      return cmdAnchor(argv);
    case "prove":
      return cmdProve(argv);
    case "verify":
      return cmdVerify(argv);
    case "memo":
      return cmdMemo(argv);
    default:
      process.stdout.write(USAGE);
      if (command) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
