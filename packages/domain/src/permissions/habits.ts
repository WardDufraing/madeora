/**
 * Habit permissions (S28). Pure and framework-free, like ./home.ts. The database makes the same
 * decisions on every call (`private.habit_access`, `private.habit_may` in
 * supabase/migrations/*_habits.sql); the server and the interface use this module to decide what to
 * offer, never instead of those checks.
 *
 * Default picked in the S28 brief (the per-module permission matrix is open in the spec; the owner
 * may override):
 * - Personal habit: its owner does everything; nobody else sees it.
 * - Home habit: every current member views it and its insights. Members check in, undo, add notes
 *   and set their own reminders unless a habit manager set the Home's habits to `view`. Habit
 *   managers (the Owner, Administrators granted `manageHomeHabits`) always create, edit, pause,
 *   end, reactivate, archive and delete habits and set that member access.
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

export const habitMemberAccess = ["complete", "view"] as const;
export type HabitMemberAccess = (typeof habitMemberAccess)[number];

/** What a person may do with a context's habits, as `private.habit_access` answers it. */
export const habitAccessLevels = ["manage", "complete", "view"] as const;
export type HabitAccess = (typeof habitAccessLevels)[number];

export const habitActions = ["habits.view", "habits.complete", "habits.manage"] as const;
export type HabitAction = (typeof habitActions)[number];

/** A habit context and the Home's member access, as the database reports them now. */
export type HabitContextFacts =
  | { readonly context: "personal" }
  | { readonly context: "home"; readonly homeId: string; readonly memberAccess: HabitMemberAccess };

const rank: { readonly [A in HabitAccess]: number } = { manage: 3, complete: 2, view: 1 };
const need: { readonly [A in HabitAction]: number } = {
  "habits.manage": 3,
  "habits.complete": 2,
  "habits.view": 1,
};

/**
 * The person's access to a context's habits: null when they are not theirs to see. For a Home,
 * `membership` is their current membership of that Home (null: none); another Home's never counts.
 */
export function habitAccess(
  context: HabitContextFacts,
  membership: HomeMembershipFacts | null,
): HabitAccess | null {
  if (context.context === "personal") return "manage";
  if (!decideHomeAction(context.homeId, membership, "home.habits.view").allowed) return null;
  if (decideHomeAction(context.homeId, membership, "home.habits.manage").allowed) return "manage";
  return context.memberAccess;
}

/** Whether a level (as the database answers it) allows `action`. */
export function habitAccessAllows(access: HabitAccess | null, action: HabitAction): boolean {
  return access !== null && rank[access] >= need[action];
}

/** Whether the person may perform `action` on the context's habits now. */
export function decideHabitAction(
  context: HabitContextFacts,
  membership: HomeMembershipFacts | null,
  action: HabitAction,
): HomeDecision {
  const access = habitAccess(context, membership);
  if (access === null) return { allowed: false, reason: "not-member" };
  return habitAccessAllows(access, action)
    ? { allowed: true }
    : { allowed: false, reason: "not-permitted" };
}

export type HabitPermissionProjection = { readonly [A in HabitAction]: boolean };

/** Every habit action's answer for one level, for the interface. Never authoritative. */
export function habitPermissions(access: HabitAccess | null): HabitPermissionProjection {
  return {
    "habits.view": habitAccessAllows(access, "habits.view"),
    "habits.complete": habitAccessAllows(access, "habits.complete"),
    "habits.manage": habitAccessAllows(access, "habits.manage"),
  };
}
