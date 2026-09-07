/**
 * Selects which of the subject's existing Trust Check flags are worth
 * surfacing alongside a fraud report. No new signal is computed here —
 * Trust Check already did that independently of this report; this only
 * filters, it never re-scores.
 */

import type { RelevantSignal } from "./types.js";

/**
 * "info" flags describe normal ledger shape (e.g. low history) rather than
 * anything resembling risk, so they add noise to an investigation without
 * adding evidence. warning/high flags are the ones worth citing next to an
 * accusation.
 */
export function extractRelevantSignals(subjectFlags: RelevantSignal[]): RelevantSignal[] {
  return subjectFlags.filter((flag) => flag.severity === "warning" || flag.severity === "high");
}
