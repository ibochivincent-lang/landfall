# MCP server

`scripts/mcp/server.mjs` — a [Model Context Protocol](https://modelcontextprotocol.io)
server that lets an AI agent query Landfall's settlement data directly, as
structured tool calls, instead of browsing the dashboard or hand-parsing the
REST/GraphQL JSON.

Like the GraphQL layer (`docs/GRAPHQL_API.md`), **this does not duplicate any
query logic.** Every tool below calls the same exported functions the REST
route and GraphQL resolvers already use — `latestScan`, `accountRows`,
`paymentsPage`, `assetRows`, `domainAccounts`, `corridorRows`,
`computeDomainReliability`, all from `api/[...path].js`. Three interfaces,
one source of truth for what the ledger actually says.

## Running it

Needs read access to the same Postgres database the API uses:

```bash
DATABASE_URL=postgresql://... node scripts/mcp/server.mjs
# or
DATABASE_URL=postgresql://... npm run mcp
```

It speaks MCP over stdio — it isn't an HTTP server, and it isn't meant to be
run standalone in a terminal; an MCP client launches it as a subprocess and
talks JSON-RPC over its stdin/stdout. (It logs its one startup line to
stderr specifically so it never pollutes that stdout channel.)

### Connecting a client

Claude Desktop / Claude Code style config (`claude_desktop_config.json` or
equivalent):

```json
{
  "mcpServers": {
    "landfall": {
      "command": "node",
      "args": ["/absolute/path/to/landfall/scripts/mcp/server.mjs"],
      "env": {
        "DATABASE_URL": "postgresql://..."
      }
    }
  }
}
```

Use a read-only database role if one is available — every tool this server
exposes is a `SELECT`, but the connection string controls that, not the code.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `landfall_anchors` | — | Every tracked account plus reliability score/grade per domain, from the latest scan |
| `landfall_anchor_detail` | `domain` | One anchor's reliability breakdown and accounts; `found: false` if untracked |
| `landfall_payments` | `domain?`, `direction?`, `asset?`, `before?`, `limit?` | A page of indexed payments, optionally scoped to one anchor |
| `landfall_assets` | — | Payment counts grouped by asset |
| `landfall_corridors` | — | Cross-asset settlement flows grouped by asset pair |
| `landfall_health` | — | Whether a scan has completed and how stale it is, in hours |

Each tool returns its result as a JSON text block. Failures (bad domain
filter, database error) come back as a tool error with a plain-English
message rather than throwing — an agent calling this shouldn't need to parse
a stack trace to know a query came back empty versus broken.

## Why this exists, not a dispute route or the SDK

The user asked specifically for MCP and GraphQL to be built next, ahead of
the dispute-resolution route and the `@landfall/sdk` package this session had
otherwise flagged as higher-value before the SCF deadline — both of those
remain **designed, not built** (`docs/gaps.md`). This page and
`docs/GRAPHQL_API.md` are scoped to exactly what was asked for.

## Verification

Tested end-to-end against a real, seeded local Postgres database using the
MCP SDK's own client (`@modelcontextprotocol/sdk/client`) — not a hand-rolled
JSON-RPC script — spawning the actual server process over stdio exactly as a
real client would, then calling `tools/list` and every tool listed above,
including a lookup for a domain that doesn't exist (`found: false`, not an
error). All six tools returned clean, correct results against seeded data
(one anchor, one live and one dark account, a path payment populating
`corridors`).

## A known gap this surfaced

Building this against `packages/api/src/server.ts` (the local dev API) would
have required either duplicating query logic or backporting a large amount of
work a teammate has since pushed straight to the deployed
`api/[...path].js` (developer portal auth, reliability scoring, corridors,
badges — none of which exist in the local dev server). Rather than rush that
backport under the SCF deadline, this server and the GraphQL layer both
import directly from `api/[...path].js`, the file actually running in
production. `packages/api/src/server.ts` is now meaningfully behind what's
deployed; see `docs/gaps.md` for the honest accounting of that gap.
