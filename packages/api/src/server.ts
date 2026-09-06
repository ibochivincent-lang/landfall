/**
 * Landfall API — local dev runner for the real API.
 *
 * This used to be a second, independent implementation: a raw node:http
 * server, ~700 lines of hand-written routes against the same Postgres
 * tables api/[...path].js also queries. It drifted. The Vercel deployment
 * gained the Developer Portal, dynamic SVG badges, the wallet pre-flight
 * health-check, and the corridors endpoint, and none of it was ever
 * backported here — this file's own header used to say admin auth "mirrors
 * api/[...path].js exactly", which stopped being true the moment either
 * file changed without the other. `npm run api` ran a system silently
 * missing roughly half its endpoints.
 *
 * Rather than backport the missing half — which only recreates the same
 * problem the next time either file changes — this now runs the exact code
 * Vercel deploys, unmodified. api/[...path].js exports one (req, res)
 * handler written against a small, deliberate subset of the Vercel Node
 * response API (`res.status(code).json(body)`, `.send(text)`,
 * `.setHeader()`) and nothing else Vercel-specific: it parses query strings
 * and cookies by hand rather than reading `req.query`/`req.cookies`, which
 * is what makes it possible to run unmodified under plain
 * `http.createServer`. The only thing this file supplies is those two
 * response methods, which a bare `http.ServerResponse` doesn't have.
 * Everything else — every route, every query, every bugfix — lives in
 * exactly one place from now on.
 *
 *   npm run api        (repo root, or -w @landfall/api)
 *
 * Needs DATABASE_URL in the environment. The handler's own pool() reads it
 * lazily and returns 503 without it — same behavior as on Vercel, not
 * reimplemented here.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env["PORT"] ?? 8787);

/**
 * The exact shape api/[...path].js calls on `res` — verified directly
 * against that file (`grep -oE "res\.[a-zA-Z]+\(" api/[...path].js`), not
 * assumed. Adding anything beyond this would be guessing at Vercel's full
 * response API instead of the slice actually used.
 */
interface VercelLikeResponse extends ServerResponse {
  status(code: number): VercelLikeResponse;
  json(body: unknown): VercelLikeResponse;
  send(body: string): VercelLikeResponse;
}

function withVercelHelpers(res: ServerResponse): VercelLikeResponse {
  const r = res as VercelLikeResponse;
  r.status = (code: number): VercelLikeResponse => {
    r.statusCode = code;
    return r;
  };
  r.json = (body: unknown): VercelLikeResponse => {
    if (!r.getHeader("Content-Type")) {
      r.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    r.end(JSON.stringify(body));
    return r;
  };
  // Used once, for the SVG badge route, which sets Content-Type itself
  // before calling res.status(200).send(svg) — this must not overwrite it.
  r.send = (body: string): VercelLikeResponse => {
    r.end(body);
    return r;
  };
  return r;
}

type VercelHandler = (req: IncomingMessage, res: VercelLikeResponse) => Promise<unknown>;

async function loadHandler(): Promise<VercelHandler> {
  // Dynamic, not static: api/[...path].js is a plain JS file outside this
  // package's TypeScript project, and importing it dynamically means this
  // package's own tsconfig does not need to know how to typecheck a 1,500+
  // line file it does not own. The literal "[...path].js" filename is
  // Vercel's catch-all-route convention, not a glob — it names one exact file.
  // api/[...path].js has no .d.ts and isn't part of this package's TS
  // project (see the file header for why it stays a plain .js file rather
  // than gaining one just to satisfy this one import) — the cast below is
  // exactly as much type information as this file actually needs from it.
  // @ts-expect-error TS7016: no declaration file for a plain .js module
  const mod = (await import("../../../api/[...path].js")) as { default: VercelHandler };
  return mod.default;
}

async function main(): Promise<void> {
  const handler = await loadHandler();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    Promise.resolve(handler(req, withVercelHelpers(res))).catch((err: unknown) => {
      console.error("[landfall-api]", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`Landfall API (running api/[...path].js directly) on http://localhost:${PORT}`);
    if (!process.env["DATABASE_URL"]) {
      console.log("DATABASE_URL is not set — every route will return 503, same as the Vercel deployment without it.");
    }
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
