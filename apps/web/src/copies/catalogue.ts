/**
 * Personal-to-Home copies (S40 part 2). The database is the authority (`private.home_copy_requests`,
 * `private.copy_item_eligible`); these lists only drive the interface.
 */
export const COPY_ITEM_TYPES = ["recipe", "calendar_event", "photo_album"] as const;
export type CopyItemType = (typeof COPY_ITEM_TYPES)[number];

export function isCopyItemType(value: unknown): value is CopyItemType {
  return (COPY_ITEM_TYPES as readonly unknown[]).includes(value);
}

export const COPY_STATUSES = [
  "pending",
  "copying",
  "completed",
  "rejected",
  "cancelled",
  "expired",
  "invalidated",
  "failed",
] as const;
export type CopyStatus = (typeof COPY_STATUSES)[number];

export function isCopyStatus(value: unknown): value is CopyStatus {
  return (COPY_STATUSES as readonly unknown[]).includes(value);
}

/** What one Home's part of a request came to right away. */
export const COPY_OUTCOMES = [
  "completed",
  "copying",
  "pending",
  "already_open",
  "not_member",
  "failed",
  "invalidated",
] as const;
export type CopyOutcome = (typeof COPY_OUTCOMES)[number];

/** Codes the database gives for an ended request (others read as the generic reason). */
export const COPY_END_CODES = [
  "storage_full",
  "limit",
  "too_many_photos",
  "not_member",
  "item_unavailable",
  "item_deleted",
  "item_trashed",
  "source_missing",
  "storage_unavailable",
  "storage_not_configured",
  "copy_timeout",
  "not_authorized",
] as const;
export type CopyEndCode = (typeof COPY_END_CODES)[number];

export function endCodeOf(value: unknown): CopyEndCode | "other" {
  return (COPY_END_CODES as readonly unknown[]).includes(value) ? (value as CopyEndCode) : "other";
}

/** Where an item lives, to link back to it from the copy page. */
export function itemPath(type: CopyItemType, id: string): string {
  const safe = encodeURIComponent(id);
  if (type === "recipe") return `/recipes/${safe}`;
  if (type === "calendar_event") return `/calendar/events/${safe}`;
  return `/photos?album=${safe}`;
}

/** The copy page for one of the person's items. */
export function copyPagePath(type: CopyItemType, id: string): string {
  return `/copy-to-home?type=${type}&id=${encodeURIComponent(id)}`;
}
