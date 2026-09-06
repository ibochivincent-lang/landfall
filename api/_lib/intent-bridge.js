/**
 * intent-bridge.js — makes the Intent Engine available to the serverless
 * function without a third copy of its arithmetic.
 *
 * packages/web/intent.js is a plain browser script: an IIFE that assigns
 * `LandfallIntent` onto globalThis. That makes it importable here for its
 * side effect, which is exactly what this file does — and why the Intent
 * Engine's maths lives in one plain-JS file rather than two.
 *
 * Why a bridge file instead of importing it directly from api/[...path].js:
 * the relative path from that file crosses out of the `api/` directory,
 * which Vercel's bundler traces but does not always include for a route
 * file. Keeping the import in `_lib/` (underscore-prefixed, so Vercel does
 * not treat it as a route) puts it on the normal module graph, and gives
 * this one line somewhere to be explained.
 *
 * If the import ever fails, this throws at module load rather than leaving
 * a route to fail mysteriously at request time with a missing global.
 */

import "../../packages/web/intent.js";

if (!globalThis.LandfallIntent || typeof globalThis.LandfallIntent.solveIntent !== "function") {
  throw new Error(
    "packages/web/intent.js did not define globalThis.LandfallIntent.solveIntent — " +
      "the Intent Engine bridge is broken, see api/_lib/intent-bridge.js",
  );
}

export const LandfallIntent = globalThis.LandfallIntent;
