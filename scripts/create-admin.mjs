/**
 * create-admin.mjs
 *
 * Creates (or resets the password for) an admin account for the developer
 * board at /admin. There is no public sign-up route on purpose — this script
 * is the only way an account gets made, run once by whoever holds the
 * database credentials.
 *
 *   DATABASE_URL=postgres://... node scripts/create-admin.mjs <username>
 *
 * Prompts for a password (not echoed) rather than taking it as an argument,
 * so it never lands in shell history or `ps`.
 *
 * Uses the same scrypt hashing as api/[...path].js — duplicated rather than
 * imported, since that file is a Vercel function entry point and this script
 * needs to run standalone with plain `node`.
 */

import pg from 'pg';
import { scrypt as scryptCb, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const { Pool } = pg;
const scrypt = promisify(scryptCb);

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function readPasswordHidden(prompt) {
  return new Promise((resolvePromise) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';
    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r' || char === '') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        process.stdout.write('\n');
        resolvePromise(password);
        return;
      }
      if (char === '') process.exit(1); // Ctrl-C
      if (char === '' || char === '\b') { password = password.slice(0, -1); return; }
      password += char;
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const username = (process.argv[2] || '').trim().toLowerCase();
  if (!username || !/^[a-z0-9_.-]{3,32}$/.test(username)) {
    console.error('Usage: DATABASE_URL=... node scripts/create-admin.mjs <username>');
    console.error('Username: 3-32 chars, lowercase letters/digits/._- only.');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const password = await readPasswordHidden('New admin password (hidden): ');
  if (password.length < 12) {
    console.error('\nPassword must be at least 12 characters.');
    process.exit(1);
  }
  const confirm = await readPasswordHidden('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords did not match.');
    process.exit(1);
  }

  const needsTls = /sslmode=require|neon\.tech|supabase\.|railway\.app|render\.com|rds\.amazonaws/.test(connectionString);
  // pg (>=8.23) treats a `sslmode=require` query param on the connection
  // string as "verify-full" and, when both a connectionString and an
  // explicit `ssl` option are given, the string-parsed setting silently
  // wins over rejectUnauthorized: false - the two don't merge, the second
  // one clobbers the first. Strip sslmode here and drive TLS purely from
  // the explicit ssl option below, or Supabase's pooler cert (which isn't
  // in Node's default CA store) fails with "self-signed certificate in
  // certificate chain" even though rejectUnauthorized: false is set.
  const poolConnectionString = connectionString.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const pool = new Pool({
    connectionString: poolConnectionString,
    connectionTimeoutMillis: 8_000,
    ...(needsTls ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO admin_users (username, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id, (xmax = 0) AS inserted`,
      [username, hash],
    );
    const created = rows[0]?.inserted;
    console.log(`\n${created ? 'Created' : 'Updated password for'} admin user '${username}'.`);
    console.log('Log in at /admin on the deployed site (or http://localhost:8080/admin locally).');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
