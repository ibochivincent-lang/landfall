/**
 * intent-bridge.js — exports LandfallIntent cleanly from @landfall/intents
 * as a pure ESM module, eliminating reliance on globalThis.
 *
 * Author: ibochivincent-lang
 */

import { LandfallIntent } from '@landfall/intents';

if (!LandfallIntent || typeof LandfallIntent.solveIntent !== 'function') {
  throw new Error('@landfall/intents did not export LandfallIntent.solveIntent');
}

export { LandfallIntent };
