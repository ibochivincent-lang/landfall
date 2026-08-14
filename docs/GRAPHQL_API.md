# GraphQL API

`POST /api/v1/graphql` (also accepts `GET` with `?query=` for quick testing) on
the deployed API — `https://landfall-ib.vercel.app/api/v1/graphql`.

It answers the same questions as the REST endpoints (`/api/v1/anchors`,
`/api/v1/corridors`, `/api/v1/assets`, `/api/v1/anchors/{domain}/payments`) —
this exists because a caller that needs three of those five endpoints in one
screen was making three round trips and throwing most of each payload away.
One query gets exactly the fields asked for.

**No new query logic was written for this.** Every resolver below is a thin
wrapper around the exact functions the REST route already calls —
`latestScan`, `accountRows`, `paymentsPage`, `assetRows`, `domainAccounts`,
`corridorRows`, `computeDomainReliability`, all exported from
`api/[...path].js`. GraphQL and REST read the same rows; only the shape of the
response differs. The MCP server (`docs/MCP.md`) reuses the same functions
again, directly — three ways to ask, one place the answer comes from.

## Schema

```graphql
type Account {
  account: String!
  domain: String!
  name: String!
  state: String!
  inbound: Int!
  outbound: Int!
  returns: Int!
  returnRate: Float
  hoursSinceActivity: Float
  topCounterpartyShare: Float
}

type ReliabilityFactors {
  liveness: Int!
  settlement: Int!
  volume: Int!
  freshestHours: Float
  totalPayments: Int!
  returnRatePercent: Float!
}

type DomainReliability {
  domain: String!
  score: Int!
  grade: String!
  status: String!
  recommendation: String!
  factors: ReliabilityFactors!
}

type AnchorDetail {
  domain: String!
  healthy: Boolean!
  score: Int!
  grade: String!
  status: String!
  recommendation: String!
  factors: ReliabilityFactors!
  accounts: [Account!]!
}

type AnchorsResult {
  asOf: String!
  staleHours: Float!
  accounts: [Account!]!
  reliability: [DomainReliability!]!
}

type Payment {
  txHash: String!
  from: String!
  to: String!
  fromDomain: String
  toDomain: String
  amount: String!
  asset: String!
  memo: String
  createdAt: String!
  isDust: Boolean!
}

type PaymentsPage {
  payments: [Payment!]!
  nextCursor: String
}

type AssetTotal {
  asset: String!
  count: Int!
}

type Corridor {
  fromAsset: String!
  toAsset: String!
  count: Int!
  volume: Float!
  firstSeen: String!
  lastSeen: String!
}

type Health {
  ok: Boolean!
  asOf: String
  staleHours: Float
}

type Query {
  anchors: AnchorsResult!
  anchor(domain: String!): AnchorDetail
  payments(domain: String, direction: String, asset: String, before: String, limit: Int): PaymentsPage!
  assets: [AssetTotal!]!
  corridors: [Corridor!]!
  health: Health!
}
```

There is no mutation type. This is a read-only ledger view, same as the REST
API — nothing here writes to the database.

## Examples

Every tracked anchor, its reliability score, and its accounts, in one call:

```bash
curl -s https://landfall-ib.vercel.app/api/v1/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ anchors { asOf staleHours reliability { domain score grade } accounts { account domain state } } }"}'
```

One anchor, by domain — returns `null` for `anchor` (not an error) if the
domain isn't tracked:

```bash
curl -s https://landfall-ib.vercel.app/api/v1/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"query($d: String!) { anchor(domain: $d) { score grade recommendation } }","variables":{"d":"example-anchor.com"}}'
```

Corridors and assets in a single round trip, where REST needs two requests:

```bash
curl -s https://landfall-ib.vercel.app/api/v1/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ corridors { fromAsset toAsset count volume } assets { asset count } }"}'
```

Quick `GET`-based testing in a browser or with no request body:

```
https://landfall-ib.vercel.app/api/v1/graphql?query={health{ok asOf staleHours}}
```

## Errors

Invalid queries (unknown fields, wrong argument types) return HTTP 400 with a
standard GraphQL `errors` array and no `data` — the schema is enforced by the
`graphql` reference implementation (`graphql-js`), not hand-rolled validation.
A syntactically valid query for a domain that doesn't exist is not an
error — `anchor(domain: "unknown")` resolves to `null`, same as REST's 404
convention for `/api/v1/anchors/{domain}`.

## Implementation

- `graphqlSchema` and `graphqlRootValue(db)` are both exported from
  `api/[...path].js`, executed via `graphql({ schema, source, variableValues,
  rootValue })` (the `graphql` npm package, GraphQL.js) — no separate GraphQL
  server or extra deployment, it's one more route inside the existing
  serverless function.
- Verified against a real, freshly migrated, seeded local Postgres database
  before shipping (`006_corridors_view.sql` applied, an anchor with a live and
  a dark account, a path payment to populate `corridors`) — all seven query
  types plus one deliberately malformed query, confirming clean results and a
  graceful GraphQL-level error rather than a crash.
