/**
 * Calendar permissions (S32). Pure and framework-free, like ./pets.ts. The database makes the same
 * decisions on every call (`private.calendar_level`, `private.calendar_can_see`,
 * `private.calendar_can_edit`, `private.calendar_can_delete` in supabase/migrations/*_calendar.sql);
 * the server and the interface use this module to decide what to offer, never instead of those
 * checks.
 *
 * Matrix in the S32 brief (spec "Confirmed shared Home calendar authorization": Home permissions
 * decide who edits Home events whoever created them, and editing and deleting are separate):
 * - A personal event is its owner's alone: only they see, edit, delete and share it. Shared with a
 *   Home, every current member there sees it in full, read-only. Home permissions never reach it.
 * - A Home event: every current member sees it. A per-member level decides the rest: `view`, `edit`
 *   (create and edit; the default) or `edit_delete` (also delete and restore). Calendar managers (the
 *   Owner, Administrators granted `manageHomeCalendar`) are `manage`: everything, and they set the
 *   other members' levels, never their own or another manager's.
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

/** A level as stored for a member (no row: `edit`). */
export const calendarMemberLevels = ["view", "edit", "edit_delete"] as const;
export type CalendarMemberLevel = (typeof calendarMemberLevels)[number];

/** A level as the database answers it: a member's, or `manage`. */
export const calendarLevels = ["manage", ...calendarMemberLevels] as const;
export type CalendarLevel = (typeof calendarLevels)[number];

export const DEFAULT_CALENDAR_LEVEL: CalendarMemberLevel = "edit";

export const calendarActions = [
  "calendar.view",
  "calendar.edit",
  "calendar.delete",
  "calendar.manage",
] as const;
export type CalendarAction = (typeof calendarActions)[number];

const rank: { readonly [L in CalendarLevel]: number } = {
  manage: 4,
  edit_delete: 3,
  edit: 2,
  view: 1,
};
const need: { readonly [A in CalendarAction]: number } = {
  "calendar.manage": 4,
  "calendar.delete": 3,
  "calendar.edit": 2,
  "calendar.view": 1,
};

/**
 * The person's level in a Home's calendar: null when they are not a current member of it. A stored
 * level counts only for someone who does not manage the calendar.
 */
export function calendarLevel(
  homeId: string,
  membership: HomeMembershipFacts | null,
  stored: CalendarMemberLevel | null,
): CalendarLevel | null {
  if (!decideHomeAction(homeId, membership, "home.calendar.view").allowed) return null;
  if (decideHomeAction(homeId, membership, "home.calendar.manage").allowed) return "manage";
  return stored ?? DEFAULT_CALENDAR_LEVEL;
}

/** Whether a level (as the database answers it) allows `action` on Home events. */
export function calendarLevelAllows(level: CalendarLevel | null, action: CalendarAction): boolean {
  return level !== null && rank[level] >= need[action];
}

/** An event as far as permissions go: personal (with its owner) or a Home's. */
export type CalendarEventFacts =
  | { readonly owner: "personal"; readonly ownedByViewer: boolean }
  | { readonly owner: "home"; readonly level: CalendarLevel | null };

/**
 * Whether the person may perform `action` on one event they can see. A personal event is decided
 * by ownership alone: someone else's (shared with a Home) is read-only, whatever their Home level.
 */
export function decideCalendarEventAction(
  event: CalendarEventFacts,
  action: Exclude<CalendarAction, "calendar.manage">,
): HomeDecision {
  if (event.owner === "personal") {
    if (event.ownedByViewer) return { allowed: true };
    return action === "calendar.view"
      ? { allowed: true }
      : { allowed: false, reason: "not-permitted" };
  }
  if (event.level === null) return { allowed: false, reason: "not-member" };
  return calendarLevelAllows(event.level, action)
    ? { allowed: true }
    : { allowed: false, reason: "not-permitted" };
}

/**
 * Whether a calendar manager may set `target`'s level: never their own, never another manager's
 * (the Owner, or an Administrator granted manageHomeCalendar).
 */
export function canChangeCalendarLevel(
  actorLevel: CalendarLevel | null,
  target: { readonly isSelf: boolean; readonly level: CalendarLevel | null },
): boolean {
  return (
    actorLevel === "manage" && !target.isSelf && target.level !== null && target.level !== "manage"
  );
}

export type CalendarPermissionProjection = { readonly [A in CalendarAction]: boolean };

/** Every action's answer for one Home level, for the interface. Never authoritative. */
export function calendarPermissions(level: CalendarLevel | null): CalendarPermissionProjection {
  return {
    "calendar.view": calendarLevelAllows(level, "calendar.view"),
    "calendar.edit": calendarLevelAllows(level, "calendar.edit"),
    "calendar.delete": calendarLevelAllows(level, "calendar.delete"),
    "calendar.manage": calendarLevelAllows(level, "calendar.manage"),
  };
}
