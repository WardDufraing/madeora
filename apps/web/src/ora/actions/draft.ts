import type { OraActionId } from "./types";

/**
 * An unfinished guided change, kept in memory only (spec "temporary unfinished-action drafts"): it
 * is never saved or sent anywhere, belongs to the place Ora was open in (the panel is rebuilt for
 * another Home or Personal), and goes with the page. `recordId` is made once per draft so a retried
 * confirmation returns the same record.
 */
export interface ActionDraft {
  readonly text: string;
  /** `YYYY-MM-DD` or empty (tasks only). */
  readonly due: string;
  readonly listId: string;
  readonly recordId: string;
  /** The person chose to add an item that is already on the list. */
  readonly allowDuplicate: boolean;
}

export type ActionDrafts = Partial<Record<OraActionId, ActionDraft | undefined>>;

export function newDraft(): ActionDraft {
  return { text: "", due: "", listId: "", recordId: crypto.randomUUID(), allowDuplicate: false };
}
