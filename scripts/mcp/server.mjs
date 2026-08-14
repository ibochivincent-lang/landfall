#!/usr/bin/env node
// ===========================================================
// Landfall MCP server
//
// Exposes the same read-only settlement data the public API and GraphQL
// endpoint serve, as MCP tools an agent can call directly — no browsing a
// dashboard, no scraping JSON, just structured tool calls over stdio.
//
// This does NOT re-implement any query logic. Every tool below is a thin
// wrapper around the exact same exported functions the live Vercel API
// route (`api/[...path].js`) and its GraphQL layer already use:
// `latestScan`, `accountRows`, `paymentsPage`, `assetRows`, `domainAccounts`,
// `corridorRows`, and `computeDomainReliability`. One source of truth for
// "what does the ledger say" — three ways to ask it (REST, GraphQL, MCP).
//
// Run:
//   DATABASE_URL=postgresql://... node scripts/mcp/server.mjs
//
// Then point an MCP-capable client (Claude Desktop, Claude Code, etc.) at
// this command over stdio. See docs/MCP.md for a full client config example.
// ===========================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  pool,
  latestScan,
  accountRows,
  paymentsPage,
  assetRows,
  domainAccounts,
  corridorRows,
  computeDomainReliability,
} from '../../api/[...path].js';

function text(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorText(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}

async function reliabilityByDomain(db) {
  const accounts = await accountRows(db);
  const byDomain = new Map();
  for (const a of accounts) {
    if (!byDomain.has(a.domain)) byDomain.set(a.domain, []);
    byDomain.get(a.domain).push(a);
  }
  return [...byDomain.entries()].map(([domain, dAccounts]) => ({
    domain,
    ...computeDomainReliability(dAccounts),
  }));
}

function buildServer() {
  const db = pool();
  if (!db) {
    throw new Error(
      'DATABASE_URL is not set. The Landfall MCP server needs read access to the same ' +
        'Postgres database the API uses — see docs/MCP.md for connection string options.'
    );
  }

  const server = new McpServer({ name: 'landfall', version: '0.2.0' });

  server.registerTool(
    'landfall_anchors',
    {
      title: 'List tracked anchors',
      description:
        'Every tracked anchor account from the latest completed scan, plus a computed ' +
        'Reliability Score (0-100, grade A-F) per domain. This is the same data the ' +
        'public /anchors dashboard and GraphQL `anchors` query serve — start here.',
      inputSchema: {},
    },
    async () => {
      try {
        const scan = await latestScan(db);
        if (!scan) return text({ error: 'No completed scan yet.' });
        const accounts = await accountRows(db);
        const reliability = await reliabilityByDomain(db);
        return text({ asOf: scan.finishedAt, staleHours: scan.staleHours, accounts, reliability });
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    'landfall_anchor_detail',
    {
      title: 'Get one anchor domain\'s detail',
      description:
        'Reliability score, grade, factor breakdown, and every tracked account for a single ' +
        'anchor home domain. Returns null (as `found: false`) if the domain is not tracked.',
      inputSchema: { domain: z.string().describe('Anchor home domain, e.g. "example-anchor.com"') },
    },
    async ({ domain }) => {
      try {
        const accounts = (await accountRows(db)).filter(
          (a) => a.domain.toLowerCase() === domain.toLowerCase()
        );
        if (!accounts.length) return text({ found: false, domain });
        const rel = computeDomainReliability(accounts);
        return text({ found: true, domain, healthy: rel.score >= 55, ...rel, accounts });
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    'landfall_payments',
    {
      title: 'Browse indexed settlement payments',
      description:
        'Page through on-chain payments already indexed for one anchor domain (or every ' +
        'tracked anchor if `domain` is omitted). Supports direction/asset filters and ' +
        'cursor-based pagination via `before`/`nextCursor`, same as the REST and GraphQL ' +
        'payments endpoints.',
      inputSchema: {
        domain: z.string().optional().describe('Restrict to one anchor home domain'),
        direction: z.enum(['inbound', 'outbound']).optional(),
        asset: z.string().optional().describe('Asset code or code:issuer filter'),
        before: z.string().optional().describe('Cursor from a previous page\'s nextCursor'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50, max 500'),
      },
    },
    async ({ domain, direction, asset, before, limit }) => {
      try {
        let accounts;
        if (domain) {
          accounts = await domainAccounts(db, domain);
          if (!accounts.length) return text({ error: `No accounts for ${domain}` });
        }
        const page = await paymentsPage(db, {
          accounts,
          direction: direction || null,
          asset: asset || null,
          before: before || null,
          limit: Math.min(Math.max(Number(limit) || 50, 1), 500),
        });
        return text(page);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    'landfall_assets',
    {
      title: 'Asset totals',
      description: 'Payment counts grouped by asset, across every tracked anchor.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await assetRows(db));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    'landfall_corridors',
    {
      title: 'Cross-asset settlement corridors',
      description:
        'Aggregated cross-asset payment flows (path payments where the source asset differs ' +
        'from the destination asset), grouped by asset pair — volume, count, and first/last seen.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await corridorRows(db));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    'landfall_health',
    {
      title: 'Indexer health',
      description:
        'Whether a scan has completed and how stale the data currently is, in hours. Check ' +
        'this before trusting a reading — Landfall never hides a stale scan behind a "live" label.',
      inputSchema: {},
    },
    async () => {
      try {
        const scan = await latestScan(db);
        return text({ ok: true, asOf: scan?.finishedAt ?? null, staleHours: scan?.staleHours ?? null });
      } catch (err) {
        return errorText(err);
      }
    }
  );

  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP over stdio is JSON-RPC on stdout — never console.log here.
  console.error('Landfall MCP server running on stdio.');
}

main().catch((err) => {
  console.error(`Landfall MCP server failed to start: ${err.message}`);
  process.exit(1);
});
