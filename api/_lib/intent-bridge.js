/**
 * intent-bridge.js — exports LandfallIntent cleanly from @landfall/intents
 * as a pure ESM module, eliminating reliance on globalThis.
 *
 * Author: ibochivincent-lang
 */

let LandfallIntent;

try {
  const mod = await import('@landfall/intents');
  LandfallIntent = mod.LandfallIntent || mod.default || mod;
} catch {
  // Defensive fallback: if @landfall/intents build is missing in serverless runtime,
  // load packages/web/intent.js mirror to prevent total API outage
  await import('../../packages/web/intent.js');
  LandfallIntent = globalThis.LandfallIntent;
}

if (!LandfallIntent || typeof LandfallIntent.solveIntent !== 'function') {
  throw new Error('Failed to resolve LandfallIntent.solveIntent from @landfall/intents or fallback');
}

export { LandfallIntent };
