# Deploying Landfall

Landfall is four things: a static site, a read-only API, an indexer that runs
on a loop, and a Postgres database. Only the database has to be durable. If
the other three vanish you rebuild them in an afternoon; if the database
vanishes you lose the scan history, which is the one asset here that cannot be
regenerated — Horizon does not keep an archive of what an anchor looked like
last Tuesday.

That asymmetry drives every choice below.

| Piece | Where it goes | Why |
|---|---|---|
| Site (`packages/web`) | Vercel | Static. Already wired to the repo. |
| API (`packages/api`) | Any container host | Needs a persistent process and a database connection. |
| Indexer (`packages/indexer`) | Same host as the API | Same image, different command. |
| Database (`packages/db`) | Supabase | Managed, backed up, and free to start. |
| Oracle (`packages/contracts`) | Stellar testnet, then mainnet | On-chain by definition. |

---

## 1. Database — Supabase

### Create the project

1. New project at [supabase.com](https://supabase.com). Pick a region near
   your API host, not near you: the API talks to it on every request, you
   talk to it twice a month.
2. Save the database password when it is shown. It is not recoverable, only
   resettable, and resetting it invalidates every connection string you have
   already pasted somewhere.

### The two connection strings

Supabase hands out two, and using the wrong one is the most common way to lose
an afternoon here. **Project settings → Database → Connection string.**

```
Direct       postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
Transaction  postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

**Migrations use the direct string, port 5432.** The pooler on 6543 is
PgBouncer in transaction mode: it hands your statements to whichever backend
is free, so a session does not survive from one statement to the next. Our
migrations are wrapped in `BEGIN`/`COMMIT` and use `DO $$ … $$` blocks, and
under the pooler that can end up partly applied with no error to tell you.

**The API and indexer use the pooled string, port 6543.** Direct connections
are capped low on the free tier, and on some plans are IPv6-only, which
container hosts frequently are not. Note the username changes to
`postgres.PROJECT_REF` in the pooled form — it is not a typo.

Append `?sslmode=require` to both. The API already forces TLS for hostnames
matching `supabase.`, but being explicit means the string still does the right
thing if you paste it into `psql`.

### Run the migrations

```powershell
$env:MIGRATE_DATABASE_URL = "postgresql://postgres:PASSWORD@db.REF.supabase.co:5432/postgres?sslmode=require"
.\scripts\migrate.ps1
```

```bash
MIGRATE_DATABASE_URL="postgresql://postgres:PASSWORD@db.REF.supabase.co:5432/postgres?sslmode=require" \
  ./scripts/migrate.sh
```

Both apply every file in `packages/db/migrations` in order, stop on the first
error, and print the resulting `schema_version`. You should see versions 1 and
2. They are safe to re-run.

Needs `psql`. On Windows: `winget install PostgreSQL.PostgreSQL.16`, then
reopen the terminal. Or paste each migration into the Supabase SQL editor —
`001_init.sql` first, `002_hosted_lockdown.sql` second.

### What migration 002 is for, and the trap inside it

Supabase puts PostgREST in front of the `public` schema and publishes it,
authenticated by the `anon` key — a key that is meant to be visible in a
browser. It also grants `anon` full DML on tables in `public` by default. Ship
the schema without doing anything about that and a stranger can run

```
DELETE FROM payments;
```

over HTTPS. Not a data leak — everything here is public ledger data — but this
project's entire claim is that its dataset is a faithful copy of the ledger,
and a dataset anyone can edit cannot carry that claim.

`002_hosted_lockdown.sql` enables row-level security on all twelve tables,
revokes the default grants, and sets `security_invoker` on the two views so a
view cannot be used to walk around the tables' policies. On a plain local
Postgres, where the `anon` role does not exist, every clause is guarded and
the file is a no-op beyond three indexes.

**The trap:** a table's owner bypasses RLS, but a non-owner does not, and a
non-owner does not get an error either — it gets **zero rows**. Connect the API
with a restricted role and the service comes up healthy, `/health` returns
`{"ok": true}`, the dashboard renders its layout, and every anchor has silently
disappeared.

So: **connect as the owner.** On Supabase that is `postgres`. The API checks
this at startup and prints a warning naming the role if it sees RLS active with
no read policy, because a warning in the logs beats an empty dashboard nobody
can explain.

If you do want a restricted role, uncomment the policy block in section 3 of
the migration and grant it deliberately.

### Verify

```bash
psql "$MIGRATE_DATABASE_URL" -c "SELECT version FROM schema_version ORDER BY version;"
psql "$MIGRATE_DATABASE_URL" -c "\dt"
```

Twelve tables, versions 1 and 2.

---

## 2. First scan

Nothing renders until there is a scan to render. Run one from your machine
before deploying anything, so that the first thing you debug is the indexer
rather than the indexer *and* the host at once.

```powershell
$env:DATABASE_URL = "postgresql://postgres:PASSWORD@db.REF.supabase.co:5432/postgres?sslmode=require"
npm run scan -- --persist --horizon https://horizon.stellar.org
```

Use the **direct** string here too. A first scan writes several thousand rows
and the pooler adds nothing for a single long-running client.

`--persist` refuses loudly if `DATABASE_URL` is unset — it will not run a scan
and quietly write nothing. Either way the JSON lands in `out/`, which is the
durable record; the database is the queryable copy.

Then check it arrived:

```bash
psql "$DATABASE_URL" -c "SELECT id, started_at, finished_at FROM scans ORDER BY id DESC LIMIT 3;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM payments;"
```

A row in `scans` with `finished_at` set is what `latest_scan` selects on. A
scan that started and never finished is invisible to the API by design —
half a scan is not a smaller scan, it is a wrong one.

---

## 3. API and indexer

One image, two commands. `Dockerfile` builds it; `docker-compose.prod.yml`
runs both.

```bash
cp .env.production.example .env
# fill in DATABASE_URL (pooled), CORS_ORIGIN
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f
```

Check it:

```bash
curl -s http://localhost:8787/health
curl -s http://localhost:8787/api/v1/summary | head -40
```

### On a VPS

Any box with Docker. Put a TLS terminator in front — Caddy is two lines:

```
api.your-domain.com {
    reverse_proxy localhost:8787
}
```

### On Render, Railway or Fly

All three build the `Dockerfile` directly.

- **API service** — default command, expose port `8787`, health check
  `/health`.
- **Indexer service** — same image, override the command:
  ```
  npm run scan -w @landfall/indexer -- --persist --horizon https://horizon.stellar.org
  ```
  Run it as a **cron job every hour** rather than a web service. The loop in
  the compose file exists because compose has no scheduler; where a scheduler
  exists, use it. A crashed cron run is visible in a dashboard; a crashed loop
  inside a container that is still "running" is not.

Environment for both: `DATABASE_URL` (pooled), `PG_POOL_MAX`, `HORIZON_URL`.
API also needs `CORS_ORIGIN`.

### Set CORS_ORIGIN properly

`*` is the local default and is wrong on the internet. A read-only API leaks
nothing, but a wildcard lets any page fetch these numbers and present them
without the caveats — `asOf`, `staleHours`, the return-rate note — that travel
in the payload precisely so they cannot be separated from the figures. Set it
to your site's exact origin.

### Pool sizing

Supabase's free tier allows a small number of pooler connections, and every
client in every container counts.

| Service | Setting | Default | Why |
|---|---|---|---|
| API | `PG_POOL_MAX` | 8 | Read traffic is bursty and short. |
| Indexer | `INDEXER_POOL_MAX` | 2 | Single-threaded; more buys nothing. |

Stacking a large client pool on PgBouncer does not increase throughput. It
consumes the quota the indexer needs to write, and the first symptom is a scan
that fails at 3am.

---

## 4. Site — Vercel

The repo is already connected. `vercel.json` serves `packages/web` statically
with no build step.

### Point the dashboard at the API

The dashboard reads live data and ships no snapshot — a stale list of "every
transaction" would mislead in a way a stale headline figure does not. It needs
an API. There are two ways to give it one.

**Option A — the proxy (recommended).** `api/[...path].js` is a Vercel function
that forwards `/api/*` to your API. In the Vercel project settings add:

```
LANDFALL_API_URL = https://api.your-domain.com
```

Redeploy. That is the whole configuration. The dashboard calls same-origin
`/api/v1/...`, so `connect-src 'self'` in the CSP stays as it is, there is no
CORS preflight on every paginated request, and nothing in the repository names
your infrastructure.

With the variable unset the proxy returns a 503 that says so, and the dashboard
shows its "no API connected" panel. That is the intended behaviour for a fresh
fork: honestly empty, not fake.

**Option B — direct.** Set the API origin in `packages/web/dashboard.html`:

```html
<meta name="landfall-api" content="https://api.your-domain.com">
```

Then widen the CSP in `vercel.json` to name that host in `connect-src`, and set
`CORS_ORIGIN` on the API to your site. Two edits in two places that must agree,
which is why Option A is the recommendation.

### Self-hosting the site instead

`docker compose -f docker-compose.prod.yml --profile web up -d` adds an nginx
container using `deploy/nginx.conf`, which proxies `/api` to the API container
for the same same-origin reason.

---

## 5. Oracle contract

**Deployed to testnet** on 13 August 2026:
`CA2IYHFKTKSJWR5IICY6HFD55BJEGE7OMKISWMLMPFSHLESZYO3VICAG`.
Sixteen tests pass against the SDK's test environment, and the contract now
exists on a network. It is **not on mainnet**, and nothing publishes to it.

### Toolchain first

Two installs, roughly fifteen minutes between them. Check before you build,
not after:

```powershell
.\scripts\deploy-contract.ps1 -Network testnet -Preflight
```

```bash
./scripts/deploy-contract.sh testnet    # checks the same things, then proceeds
```

It reports exactly what is missing and the command that fixes it:

| Missing | Fix |
|---|---|
| Rust | `winget install Rustlang.Rustup`, then reopen the terminal |
| wasm target | `rustup target add wasm32v1-none` |
| stellar CLI | `winget install --id Stellar.StellarCLI` — check `stellar --version` reports 23+; if not, `cargo install --locked stellar-cli` |
| C linker (Windows) | see below |

Two of these catch almost everyone.

**The wasm target, and which one.** It is `wasm32v1-none`, not
`wasm32-unknown-unknown`. The second is the one every older tutorial names,
and `soroban-sdk` 27 rejects it outright:

```
Rust compiler 1.82+ with target 'wasm32-unknown-unknown' is unsupported by the
Soroban Environment, use 'wasm32v1-none' available with Rust 1.84+.
```

Rust 1.82 turned on reference-types and multi-value for that target. The
Soroban environment does not support either, and they are not easily disabled,
so the SDK's build script panics rather than emit a wasm the network would
refuse. With the right target absent you instead get ``can't find crate for
`core` ``, which reads like a broken Rust install and is not.

**A C linker, on Windows.** This one is genuinely counter-intuitive. The
output is WebAssembly, so it looks like no native toolchain should be
involved — but cargo compiles proc-macro crates and build scripts *for the
host*, because they execute on your machine during the build. On an
`x86_64-pc-windows-msvc` toolchain that needs `link.exe`, which only arrives
with Visual Studio's C++ tools. Without it you get 194 crates downloaded, a
minute of compiling, and then:

```
error: linker `link.exe` not found
```

Two ways out. Microsoft's build tools are the well-trodden path:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

That is roughly 3 GB and 15–20 minutes. The GNU toolchain is about a tenth of
the size and brings its own linker:

```powershell
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup default stable-x86_64-pc-windows-gnu
rustup target add wasm32v1-none
```

Re-adding the wasm target is not redundant. Targets are installed per
toolchain, so the one you added under msvc does not carry over — miss this and
you land straight back on ``can't find crate for `core` ``.

On Linux and macOS the equivalent is `build-essential` or the Xcode command
line tools, and it is usually already there.

### Then deploy

```powershell
.\scripts\deploy-contract.ps1 -Network testnet
```

```bash
./scripts/deploy-contract.sh testnet
```

Both scripts do the same nine things: check the toolchain, build, optimise,
generate and fund an identity, deploy, call `initialise`, read `epoch` back to
confirm the call took, write `.contract-id`, and append `ORACLE_CONTRACT_ID` to
`.env`. They refuse to run twice without `-Force` / `--force`, because a second
deploy orphans the first contract along with every consumer still pointing at
it.

Reading `epoch` back is not ceremony. `initialise` is guarded against a second
call, so a silent no-op there is the signal that the deploy reused an existing
instance rather than creating one.

`mainnet` prompts you to fund the deployer yourself and waits.

The admin secret stays in the stellar CLI keystore under the identity
`landfall-deployer`. It is not in the repository and must not be. To publish
from a server, export it into that server's secret manager:

```bash
stellar keys show landfall-deployer
```

Publishing scores from the indexer is not wired yet — it is on the backlog as a
high-value item. Deploying the contract does not by itself put anything
on-chain.

---

## 6. Checks after a deploy

```bash
# API is up and can see the database
curl -s https://api.your-domain.com/health

# there is a scan, and it is not ancient
curl -s https://api.your-domain.com/api/v1/summary | grep -E 'asOf|staleHours'

# the proxy resolves
curl -s https://your-site.vercel.app/api/v1/anchors | head -20
```

Then open `/dashboard` and confirm the freshness badge reads **Live**, not
*API unreachable*.

If it reads Live but every anchor shows zero: that is the RLS trap in section
1. Check the API logs for the startup warning.

---

## 7. Costs

| | Free tier | When you outgrow it |
|---|---|---|
| Supabase | 500 MB, pauses after 7 days idle | A mainnet scan is a few MB. The pause matters more than the size — an hourly indexer keeps it awake. |
| Vercel | Generous for a static site | The proxy function counts as an invocation. |
| API host | Render and Fly have free tiers that sleep | A sleeping API means a cold first request, not a broken one. |
| Horizon | Free, rate-limited | Respect `--concurrency`. SDF's public instance is a shared resource. |

The whole stack runs at zero for a project this size. That is deliberate — a
public-good measurement service that costs money to keep honest is one bad
month away from going quiet, which is the exact failure it exists to detect.

---

## 8. What is not automated

Stated plainly, because a deployment guide that implies more than it delivers
is the same defect this project measures in other people:

- **No CI/CD to production.** Deploys are manual. The GitHub Actions workflow
  runs tests only.
- **No database backups beyond Supabase's own.** Free tier keeps daily
  backups for seven days. If the scan history matters to you, `pg_dump` on a
  schedule.
- **No alerting.** Nothing tells you the indexer stopped. The `staleHours`
  field in every API response is the manual version of that alarm.
- **No migration rollback.** Forward-only. Both migrations are re-runnable;
  neither is reversible.
- **The indexer does not publish to the oracle.** The contract is on testnet;
  nothing writes to it, so it holds no data.
