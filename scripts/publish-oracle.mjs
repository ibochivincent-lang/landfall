/**
 * publish-oracle.mjs
 *
 * Reads the latest out/scan-*.json (same file scan-to-api.mjs reads),
 * computes a canonical SHA-256 digest over the mapped account summaries, and
 * invokes the deployed Soroban oracle's publish(digest) — the one thing
 * docs/gaps.md flagged as still missing: "the indexer does not publish to
 * it — so it is a deployed contract, not a working oracle."
 *
 * Shells out to the `stellar` CLI rather than adding @stellar/stellar-sdk as
 * a dependency: scripts/deploy-contract.sh already establishes the CLI as
 * this project's only means of contract interaction, and it already handles
 * simulation, fee estimation and RPC retries internally.
 *
 * No-ops cleanly (exit 0, clear log line) when ORACLE_CONTRACT_ID or
 * ORACLE_ADMIN_SECRET is unset, so this is safe to wire into the hourly scan
 * workflow before either secret is actually configured.
 *
 * Can also be run manually: node scripts/publish-oracle.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toAccountSummary } from './_lib/classify.mjs';

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'out');

const CONTRACT_ID = process.env.ORACLE_CONTRACT_ID;
const ADMIN_SECRET = process.env.ORACLE_ADMIN_SECRET;
const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.ORACLE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
const IDENTITY = 'landfall-ci-admin';

if (!CONTRACT_ID || !ADMIN_SECRET) {
  console.log('Oracle publish skipped — ORACLE_CONTRACT_ID/ORACLE_ADMIN_SECRET not configured.');
  process.exit(0);
}

/** Imports ADMIN_SECRET into a scratch CLI identity, via stdin — never argv, so it never lands in CI logs or process listings. */
async function importIdentity() {
  await new Promise((resolvePromise, reject) => {
    const child = execFile(
      'stellar',
      ['keys', 'add', IDENTITY, '--secret-key', '--overwrite'],
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolvePromise(stdout)),
    );
    child.stdin.write(ADMIN_SECRET.trim() + '\n');
    child.stdin.end();
  });
}

async function latestScanFile() {
  const files = (await readdir(OUT_DIR))
    .filter((f) => f.startsWith('scan-') && f.endsWith('.json'))
    .sort();
  if (!files.length) throw new Error(`No scan files found in ${OUT_DIR}`);
  return join(OUT_DIR, files.at(-1));
}

function computeDigest(raw) {
  const accounts = (raw.metrics ?? [])
    .map(toAccountSummary)
    .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  const canonical = JSON.stringify(accounts);
  return createHash('sha256').update(canonical).digest('hex');
}

async function publish(digestHex) {
  const { stdout } = await execFileP('stellar', [
    'contract', 'invoke',
    '--id', CONTRACT_ID,
    '--source-account', IDENTITY,
    '--rpc-url', RPC_URL,
    '--network-passphrase', NETWORK_PASSPHRASE,
    '--', 'publish', '--digest', digestHex,
  ]);
  return stdout.trim();
}

async function recordPublication(digestHex, scanRawGeneratedAt) {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.log('DATABASE_URL not set — publish succeeded on-chain but was not recorded in Postgres.');
    return;
  }
  const { default: pg } = await import('pg'); // lazy: only needed on this path
  const { Pool } = pg;
  const poolConnectionString = DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const pool = new Pool({ connectionString: poolConnectionString, max: 1, connectionTimeoutMillis: 8_000, ssl: { rejectUnauthorized: false } });
  try {
    const { rows } = await pool.query(
      `SELECT id FROM scans WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    );
    const scanId = rows[0]?.id ?? null;
    await pool.query(
      `INSERT INTO oracle_publications (scan_id, digest, contract_id) VALUES ($1, $2, $3) ON CONFLICT (digest) DO NOTHING`,
      [scanId, digestHex, CONTRACT_ID],
    );
    console.log(`Recorded oracle_publications row for scan ${scanId}.`);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  const scanPath = await latestScanFile();
  const raw = JSON.parse(await readFile(scanPath, 'utf8'));
  const digestHex = computeDigest(raw);

  console.log(`Publishing digest ${digestHex} from ${scanPath} to ${CONTRACT_ID} on ${RPC_URL}...`);
  await importIdentity();
  const output = await publish(digestHex);
  console.log('Publish succeeded:', output || '(no output)');

  await recordPublication(digestHex, raw.generatedAt);
}

try {
  await main();
} catch (err) {
  // Fail loudly — the workflow step already wraps this in
  // continue-on-error: true, so this script must not double-suppress.
  console.error('Oracle publish failed:', err.message);
  process.exitCode = 1;
}
