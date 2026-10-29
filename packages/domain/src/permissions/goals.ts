/**
 * Goal permissions (S30). Pure and framework-free, like ./habits.ts. The database makes the same
 * decisions on every call (`private.goal_access`, `private.goal_may` in
 * supabase/migrations/*_goals.sql); the server and the interface use this module to decide what to
 * offer, never instead of those checks.
 *
 * Default picked in the S30 brief (the owner may override):
 * - Personal goal: its owner does everything; nobody else sees it.
 * - Home goal: every current member views it and its contribution history. Members add
 *   contributions, reverse their own and mark a completion goal achieved unless a goal manager set the
 *   Home's goals to `view`. Goal managers (the Owner, Administrators granted `manageHomeGoals`) also
 *   create and change goals, set totals, correct anyone's entry, mark a measurable goal achieved,
 *   reopen, archive and delete goals and set that member access.
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

export const goalMemberAccess = ["contribute", "view"] as const;
export type GoalMemberAccess = (typeof goalMemberAccess)[number];

/** What a person may do with a context's goals, as `private.goal_access` answers it. */
export const goalAccessLevels = ["manage", "contribute", "view"] as const;
export type GoalAccess = (typeof goalAccessLevels)[number];

export const goalActions = ["goals.view", "goals.contribute", "goals.manage"] as const;
export type GoalAction = (typeof goalActions)[number];

/** A goal context and the Home's member access, as the database reports them now. */
export type GoalContextFacts =
  | { readonly context: "personal" }
  | { readonly context: "home"; readonly homeId: string; readonly memberAccess: GoalMemberAccess };

const rank: { readonly [A in GoalAccess]: number } = { manage: 3, contribute: 2, view: 1 };
const need: { readonly [A in GoalAction]: number } = {
  "goals.manage": 3,
  "goals.contribute": 2,
  "goals.view": 1,
};

/**
 * The person's access to a context's goals: null when they are not theirs to see. For a Home,
 * `membership` is their current membership of that Home (null: none); another Home's never counts.
 */
export function goalAccess(
  context: GoalContextFacts,
  membership: HomeMembershipFacts | null,
): GoalAccess | null {
  if (context.context === "personal") return "manage";
  if (!decideHomeAction(context.homeId, membership, "home.goals.view").allowed) return null;
  if (decideHomeAction(context.homeId, membership, "home.goals.manage").allowed) return "manage";
  return context.memberAccess;
}

/** Whether a level (as the database answers it) allows `action`. */
export function goalAccessAllows(access: GoalAccess | null, action: GoalAction): boolean {
  return access !== null && rank[access] >= need[action];
}

/** Whether the person may perform `action` on the context's goals now. */
export function decideGoalAction(
  context: GoalContextFacts,
  membership: HomeMembershipFacts | null,
  action: GoalAction,
): HomeDecision {
  const access = goalAccess(context, membership);
  if (access === null) return { allowed: false, reason: "not-member" };
  return goalAccessAllows(access, action)
    ? { allowed: true }
    : { allowed: false, reason: "not-permitted" };
}

export type GoalPermissionProjection = { readonly [A in GoalAction]: boolean };

/** Every goal action's answer for one level, for the interface. Never authoritative. */
export function goalPermissions(access: GoalAccess | null): GoalPermissionProjection {
  return {
    "goals.view": goalAccessAllows(access, "goals.view"),
    "goals.contribute": goalAccessAllows(access, "goals.contribute"),
    "goals.manage": goalAccessAllows(access, "goals.manage"),
  };
}
