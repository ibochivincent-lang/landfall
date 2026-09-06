# MCP server

`scripts/mcp/server.mjs` — a [Model Context Protocol](https://modelcontextprotocol.io)
server that lets an AI agent query Landfall's settlement data directly, as
structured tool calls, instead of browsing the dashboard or hand-parsing the
REST/GraphQL JSON.

Like the GraphQL layer (`docs/GRAPHQL_API.md`), **this does not duplicate any
query logic.** Every tool below calls the same exported functions the REST
route and GraphQL resolvers already use — `latestScan`, `accountRows`,
`paymentsPage`, `assetRows`, `domainAccounts`, `corridorRows`,
`computeDomainReliability`, `trustCheckResolveAddress`, `trustCheckFetchInput`,
`analyzeTrustCheck`, `fetchFraudReports`, `resolveIntent`, all from
`api/[...path].js`. Three interfaces, one source of truth for what the
ledger actually says.

Two of those exports — `resolveIntent` and `fetchFraudReports` — did not
exist as standalone functions before this server needed them; the logic
lived inline in the `POST /api/v1/intent` and `GET /api/v1/fraud-reports/:subject`
route handlers. Rather than have this file recompute either — a third copy
of arithmetic that has already drifted twice in this project's own history
(see `docs/gaps.md`) — both routes were cut down to call the same extracted
function this server calls. The REST route and this server run one
implementation of "rank a route" and "read reports for a subject", not two.

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
| `landfall_trust_check` | `address` (G... or tx hash) | Live counterparty signals for an arbitrary Stellar address — see `packages/trust-check` |
| `landfall_fraud_reports` | `subject` (G...) | Third-party reports filed about an address, each anchored to a verified on-chain transaction |
| `landfall_intent` | `from`, `to`, `basis`, `amount`, `midRate`, `candidates[]`, `sortBy?`, `minGrade?`, `requirePricedTerms?` | Every candidate route ranked, plus an executable plan for the winner |

Each tool returns its result as a JSON text block. Failures (bad domain
filter, database error) come back as a tool error with a plain-English
message rather than throwing — an agent calling this shouldn't need to parse
a stack trace to know a query came back empty versus broken. Malformed input
to `landfall_intent` (a negative `midRate`, a missing required field) is
rejected by the tool's own Zod schema before the handler runs at all, which
is a cleaner failure than a caught exception and requires no code on this
server's side to produce.

## What this deliberately does not expose

Filing a fraud report, and responding to one, are not MCP tools, and that is
a decision made once here rather than an oversight to fix later.

A fraud report is an accusation about a named party, gated on citing
verifiable on-chain evidence specifically so that filing one takes real
effort and leaves a checkable trail (`packages/fraud-reports`). An MCP tool
collapses that effort to a single function call an agent could be prompted
into making at scale — each individual call might cite real evidence and
pass verification, while the underlying characterisation (impersonation,
wrong amount, whichever category) is invented by the agent with nobody
actually defrauded. That is a lower-friction path to exactly the kind of
fabricated negative claim about a real party this project has spent
considerable effort refusing to produce anywhere else. Filing stays a
deliberately human action, taken on the Trust Check page, where a person
reads the disclosure and decides.

Disputing a report is excluded for a sharper reason: it requires an Ed25519
signature from the reported address's own key (`packages/fraud-reports/src/dispute.ts`).
No tool on this server should ever take a private key as an argument, or put
an agent in a position where doing so looks like the normal way to use it.

Both remain reachable exactly where they already were — the Trust Check page
and the REST API directly.

## Verification

The original six tools were tested end-to-end against a real, seeded local
Postgres database using the MCP SDK's own client
(`@modelcontextprotocol/sdk/client`) — not a hand-rolled JSON-RPC script —
spawning the actual server process over stdio exactly as a real client
would, then calling `tools/list` and every tool, including a lookup for a
domain that doesn't exist (`found: false`, not an error).

The three new tools were verified the same way, against the same kind of
spawned-server, real-client setup: `landfall_trust_check` returned a real
scored result for a live mainnet address; `landfall_fraud_reports` returned
a clean "no reports" summary for an address with none, and a plain
validation error (not a crash) for a malformed subject; `landfall_intent`
correctly overwrote a locally-empty ledger grade to `U` rather than trusting
the candidate's own claim, and returned a six-step plan with the expected
actor sequence (`landfall, user, wallet, wallet, anchor, user`). Deliberately
malformed input to `landfall_intent` (`midRate: -1`) was rejected by the
tool's Zod schema before reaching any handler code, confirmed by the schema
validation error itself rather than assumed.

## A gap this surfaced, since closed

Building this against `packages/api/src/server.ts` (the local dev API) would
have required either duplicating query logic or backporting a large amount of
work a teammate had pushed straight to the deployed `api/[...path].js`
(developer portal auth, reliability scoring, corridors, badges — none of
which existed in the local dev server at the time). Rather than rush that
backport under the SCF deadline, this server and the GraphQL layer both
imported directly from `api/[...path].js`, the file actually running in
production.

`packages/api/src/server.ts` has since been rewritten the same way: it no
longer has its own routes at all. It is a thin `http.createServer` wrapper
that imports `api/[...path].js`'s handler directly and adds the two response
methods (`res.status().json()`, `.send()`) a bare `http.ServerResponse`
doesn't have. `npm run api` now runs the exact code Vercel deploys — there is
one implementation, not two that can drift. See `docs/gaps.md` for the
history of the gap this closed.
