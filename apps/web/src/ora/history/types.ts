import { z } from "zod";

/**
 * Ora's seven-day interaction history (S47b; spec "Confirmed Ora seven-day rolling interaction
 * history"). Client-safe shapes. One short line per guided change or Undo, kept for the person only
 * and for seven days; it is not a transcript, has no threads or search, and never authorises a change.
 */

export const historyKinds = [
  "task-added",
  "task-undone",
  "shopping-item-added",
  "shopping-item-undone",
] as const;
export type HistoryKind = (typeof historyKinds)[number];

/** How long an entry is kept after it was made. Mirrors the database policy and its purge. */
export const HISTORY_DAYS = 7;

export interface OraHistoryEntry {
  readonly id: string;
  readonly kind: HistoryKind;
  /** The task title or item name the person typed. */
  readonly label: string;
  readonly createdAt: string;
}

export const recordHistorySchema = z.strictObject({
  homeId: z.uuid().nullable(),
  kind: z.enum(historyKinds),
  label: z.string().trim().min(1).max(200),
});
export type RecordHistoryInput = z.output<typeof recordHistorySchema>;

/** `GET /api/v1/ora/history?homeId` */
export interface OraHistoryResponse {
  readonly entries: readonly OraHistoryEntry[];
}
