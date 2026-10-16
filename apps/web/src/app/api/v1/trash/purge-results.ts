import type { PurgeResult } from "@/trash/api";

const OUTCOMES = ["purged", "not_found"] as const;

/** The database's per-entry answers as the contract's results; anything unexpected is "failed". */
export function purgeResults(
  rows: readonly { readonly entry_id: string; readonly outcome: string }[],
): PurgeResult[] {
  return rows.map((row) => ({
    entryId: row.entry_id,
    outcome: OUTCOMES.find((outcome) => outcome === row.outcome) ?? "failed",
  }));
}
