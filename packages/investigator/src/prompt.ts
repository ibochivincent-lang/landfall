/**
 * Builds the exact text sent to the model. Deterministic and pure so the
 * prompt itself is reviewable and testable — nothing about what the model
 * is told is decided at call time.
 */

import type { Prompt, RelevantSignal } from "./types.js";

const SYSTEM_PROMPT = `You are writing a short analysis for Landfall, a Stellar settlement-intelligence tool.

You will be given a list of CITED FACTS and a list of RELEVANT SIGNALS about a fraud report and the address it was filed against. Every fact and signal was independently verified against the Stellar ledger before you saw it.

Rules you must follow exactly:
1. Use only the facts and signals given to you. Never state a fact, name, amount, date, or transaction hash that was not given to you.
2. Never state or imply that the reported address committed fraud, is guilty, or is confirmed to have done anything wrong. A fraud report is an unproven accusation, not a finding.
3. Never treat the number of reports, or anything not listed in the facts, as evidence. You were not told how many other reports exist about this address, and must not guess or assume a number.
4. Explain in plain language what the given facts and signals could mean, and note anything that is missing or unverifiable — do not fill gaps with speculation.
5. Keep it to two or three short sentences.`;

function renderSignal(signal: RelevantSignal): string {
  return `- [${signal.severity}] ${signal.summary} — ${signal.detail}`;
}

export function buildPrompt(citedFacts: string[], relevantSignals: RelevantSignal[]): Prompt {
  const factsBlock = citedFacts.map((fact) => `- ${fact}`).join("\n");
  const signalsBlock =
    relevantSignals.length > 0
      ? relevantSignals.map(renderSignal).join("\n")
      : "- None. Trust Check found no warning- or high-severity signals for this address.";

  const user = `CITED FACTS:\n${factsBlock}\n\nRELEVANT SIGNALS (from Trust Check, computed independently of this report):\n${signalsBlock}\n\nWrite the analysis now, following all the rules.`;

  return { system: SYSTEM_PROMPT, user };
}
