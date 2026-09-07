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
// `corridorRows`, `computeDomainReliability`, `trustCheckResolveAddress`,
// `trustCheckFetchInput`, `analyzeTrustCheck`, `fetchFraudReports`, and
// `resolveIntent`. One source of truth for "what does the ledger say" —
// three ways to ask it (REST, GraphQL, MCP).
//
// Deliberately NOT exposed: filing a fraud report, or disputing one. See
// docs/MCP.md's "What this deliberately does not expose" for why — in
// short, one is an accusation an agent should not be able to make on
// someone's behalf at the cost of a single tool call, and the other needs a
// private key, which no tool on this server should ever take as an
// argument.
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
  trustCheckResolveAddress,
  trustCheckFetchInput,
  analyzeTrustCheck,
  fetchFraudReports,
  fetchInvestigation,
  resolveIntent,
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

  server.registerTool(
    'landfall_trust_check',
    {
      title: 'Check a Stellar address before paying it',
      description:
        'Live, ledger-only counterparty signals for an arbitrary Stellar address or transaction ' +
        'hash — observed history (a lower bound, since Horizon does not retain everything ' +
        'forever), counterparty concentration, a pass-through/fast-forwarding pattern, a ' +
        'transparent 0-100 score with every deduction traceable to a named flag, and a ' +
        'confidence rating that overrides the score when there is too little history to say ' +
        'anything. No external fraud database is consulted — none exists here that can be ' +
        'independently verified, and inventing one would be exactly the failure mode this tool ' +
        'exists to avoid in other systems. Every flag states a ledger fact, never an accusation.',
      inputSchema: {
        address: z.string().describe('A Stellar public key (G...) or a 64-character transaction hash'),
      },
    },
    async ({ address }) => {
      try {
        const resolved = await trustCheckResolveAddress(address);
        if (!resolved) {
          return text({ error: 'address must be a Stellar public key (G...) or a transaction hash.' });
        }
        const input = await trustCheckFetchInput(resolved, new Date().toISOString());
        return text(analyzeTrustCheck(input));
      } catch (err) {
        if (err.status === 404) return text({ error: 'That address has no account on the Stellar network.' });
        return errorText(err);
      }
    }
  );

  server.registerTool(
    'landfall_fraud_reports',
    {
      title: 'Read fraud reports filed about an address',
      description:
        'Reports other people have filed about a Stellar address, each anchored to a ' +
        'transaction Landfall verified exists and involves that address. These are claims by ' +
        'third parties, not findings by Landfall — the transaction is verified, the account of ' +
        'what happened is not, and report volume is never scored or ranked. A response from the ' +
        'reported party, if one exists, is attached to its report. This tool only reads; filing ' +
        'or disputing a report is a deliberately human action taken through the Trust Check page, ' +
        'not something this server exposes for an agent to do on someone\'s behalf.',
      inputSchema: {
        subject: z.string().describe('The Stellar public key (G...) the reports are about'),
      },
    },
    async ({ subject }) => {
      try {
        if (!/^G[A-Z2-7]{55}$/.test(subject)) {
          return text({ error: 'subject must be a Stellar public key (G...).' });
        }
        return text(await fetchFraudReports(db, subject));
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    'landfall_investigation',
    {
      title: 'Read the Analyzed-stage investigation for one fraud report',
      description:
        'The result of Sentinel\'s "Analyzed" stage for one fraud report, if it has been run: ' +
        'cited_facts (deterministic, computed with no AI, always present once an investigation ' +
        'exists) and relevant_signals (the subject\'s own warning/high Trust Check flags). ' +
        'narrative is an optional AI-written summary of exactly those facts, labeled with the ' +
        'model that wrote it — null whenever no model was configured. Read-only: this tool never ' +
        'triggers a new investigation (that calls a paid model and writes a row) and never reads ' +
        'how many other reports exist about the subject, the same restraint fraud reports\' own ' +
        'design applies — report counts are never treated as evidence.',
      inputSchema: {
        reportId: z.string().describe('The numeric fraud report id, from landfall_fraud_reports'),
      },
    },
    async ({ reportId }) => {
      try {
        if (!/^\d+$/.test(reportId)) return text({ error: 'reportId must be numeric.' });
        const investigation = await fetchInvestigation(db, reportId);
        if (!investigation) return text({ error: 'This report has not been investigated yet.' });
        return text(investigation);
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.registerTool(
    'landfall_intent',
    {
      title: 'Rank routes for a payment intent and get an executable plan',
      description:
        'State an outcome — send a fixed amount, or deliver a fixed amount — and get every ' +
        'candidate route ranked, plus a step-by-step plan for the winner naming who performs ' +
        'each step. Commercial terms (rate, fees) come from the caller, because they are each ' +
        'anchor\'s own published figures, not Landfall\'s — see /api/v1/anchor-fees.json and ' +
        '/api/v1/anchor-quotes.json for the tracked anchors\' current ones. The reliability grade ' +
        'is always overwritten from Landfall\'s own ledger scan, regardless of what is supplied: ' +
        'a route-ranking tool where the ranked party supplies its own score would not be one. ' +
        'Every plan step names its actor, and Landfall performs only the read-only check — every ' +
        'step that moves value belongs to the wallet or the anchor, because this tool computes a ' +
        'plan, it does not execute one, and holds no keys or funds to execute one with.',
      inputSchema: {
        from: z.string().describe('Asset the user sends, e.g. "USDC"'),
        to: z.string().describe('Destination currency, e.g. "NGN"'),
        basis: z.enum(['send', 'receive']).describe(
          '"send": amount is the fixed amount sent. "receive": amount is the fixed amount the recipient must get.'
        ),
        amount: z.number().positive(),
        midRate: z.number().positive().describe(
          'Mid-market rate, `to` units per one `from` unit. Landfall carries no FX feed and will not invent one — this is required.'
        ),
        candidates: z.array(z.object({
          domain: z.string(),
          name: z.string().optional(),
          rateSpread: z.number().optional().describe('Multiplier on midRate; 1 = mid, 0.99 = 1% spread against the user'),
          feePercent: z.number().optional(),
          feeFixed: z.number().optional(),
          feeSource: z.enum(['live', 'catalog']).optional(),
          url: z.string().optional().describe('Anchor off-ramp URL, carried into the plan'),
          speed: z.string().optional().describe('Human payout-speed description, carried into the plan'),
        })).min(1).max(50).describe('Candidate routes with their published terms — see /api/v1/anchor-fees.json'),
        sortBy: z.enum(['payout', 'verified']).optional().describe(
          '"payout" (default): most received / least sent. "verified": reliability grade, then liquidity, then price — never blended into one score.'
        ),
        minGrade: z.string().optional().describe('Reject routes graded below this (A-F, or U for untracked)'),
        requirePricedTerms: z.boolean().optional().describe('Reject routes with no published rate card, instead of listing them unpriced'),
      },
    },
    async (body) => {
      try {
        const result = await resolveIntent(db, body);
        return text(result.body);
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
