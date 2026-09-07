/**
 * Orchestration, split so the actual network call to an LLM stays isolated
 * from everything provable. `prepareInvestigation` and `assembleInvestigation`
 * are pure and fully tested; the API layer is responsible for calling an
 * LLM with the prompt `prepareInvestigation` returns (or not calling one at
 * all, when no key is configured) and passing the result — or null — into
 * `assembleInvestigation`.
 */

import { buildCitedFacts } from "./facts.js";
import { extractRelevantSignals } from "./signals.js";
import { buildPrompt } from "./prompt.js";
import type { Investigation, InvestigationInput, Prompt, RelevantSignal } from "./types.js";

export interface PreparedInvestigation {
  citedFacts: string[];
  relevantSignals: RelevantSignal[];
  prompt: Prompt;
}

/** Everything computable without touching a model. */
export function prepareInvestigation(input: InvestigationInput): PreparedInvestigation {
  const citedFacts = buildCitedFacts(input);
  const relevantSignals = extractRelevantSignals(input.subjectFlags);
  const prompt = buildPrompt(citedFacts, relevantSignals);
  return { citedFacts, relevantSignals, prompt };
}

/**
 * Combines the pure facts with whatever the API layer got back from a
 * model — or null, if no key was configured, matching the degrade pattern
 * packages/stp uses for an unsigned digest.
 */
export function assembleInvestigation(
  reportId: string,
  investigatedAt: string,
  prepared: PreparedInvestigation,
  narrative: string | null,
  narrativeModel: string | null,
): Investigation {
  return {
    reportId,
    investigatedAt,
    citedFacts: prepared.citedFacts,
    relevantSignals: prepared.relevantSignals,
    narrative: narrative ?? null,
    narrativeModel: narrative ? narrativeModel : null,
  };
}
