/**
 * Merging persisted history into a resumed scan.
 *
 * An incremental scan fetches only what is new since its stored cursor — that
 * is the point of the cursor, and it is what lets an hourly run finish in
 * seconds instead of re-paging years of ledger. But the figures a scan
 * publishes are cumulative by definition: `inbound` has always meant "payments
 * this account has received", not "payments it received since the last time we
 * looked". Computing those figures from the fetch alone silently redefines
 * every one of them to cover an hour, which is how a settlement record becomes
 * a one-hour sample wearing its clothes — and how a reliability score ends up
 * grading a named business on evidence nobody gathered.
 *
 * So the fetch stays incremental and the arithmetic stays cumulative: the
 * ledger is the input, the `payments` table is our copy of it, and the fetch
 * window is an implementation detail that must never reach a published number.
 */

import type { Store } from "./db.js";
import type { PaymentRecord } from "./types.js";

/**
 * Fetched records merged with everything already persisted for the account,
 * newest first, deduplicated by paging token.
 *
 * The paging token is unique per record and is the same value the `payments`
 * table uses as its conflict key, so an overlap between stored history and this
 * run's fetch collapses cleanly rather than double-counting.
 *
 * Returns the fetched records unchanged when there is no store or no history.
 * A history read that fails must not fail a scan that already succeeded, but it
 * must not quietly publish the smaller number either — it reports through
 * `onWarning` so the caller can say so out loud.
 */
export async function mergeWithHistory(
  store: Pick<Store, "paymentsForAccount"> | null,
  account: string,
  fetched: PaymentRecord[],
  opts: { since?: string; onWarning?: (message: string) => void } = {},
): Promise<PaymentRecord[]> {
  if (!store) return fetched;

  let history: PaymentRecord[];
  try {
    const res = await store.paymentsForAccount(account, { since: opts.since });
    history = res.records;
    if (res.truncated) {
      opts.onWarning?.(
        "history read hit its row cap; published counts understate reality",
      );
    }
  } catch (err) {
    opts.onWarning?.(
      `could not read persisted history (${err instanceof Error ? err.message : String(err)}); ` +
      "metrics for this account cover only what this run fetched",
    );
    return fetched;
  }

  if (history.length === 0) return fetched;

  const byCursor = new Map<string, PaymentRecord>();
  for (const r of history) byCursor.set(r.cursor, r);
  // Fetched records win on collision: they came straight from Horizon this run,
  // so they are the fresher copy of the same row.
  for (const r of fetched) byCursor.set(r.cursor, r);

  return [...byCursor.values()].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}
