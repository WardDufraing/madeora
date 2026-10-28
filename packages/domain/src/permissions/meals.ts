/**
 * Meal-planner permissions (S27). Pure and framework-free, like ./home.ts. The database makes the
 * same decisions on every call (`private.meal_access`, `private.meal_may` in
 * supabase/migrations/*_meal_planner.sql); the server and the interface use this module to decide
 * what to offer, never instead of those checks.
 *
 * Default picked in the S27 brief (the per-module permission matrix is open in the spec; the owner
 * may override):
 * - Personal space: its owner does everything.
 * - Home: every current member views and prints the plan. Members plan meals (add, edit, move,
 *   remove, repeating meals, copy week, ingredient transfers) unless a meal manager set the Home's
 *   planner to `view`. Meal managers (the Owner, Administrators granted `manageHomeMeals`) always
 *   plan, configure slots and set that member access.
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

export const mealMemberAccess = ["edit", "view"] as const;
export type MealMemberAccess = (typeof mealMemberAccess)[number];

/** What a person may do with a context's planner, as `private.meal_access` answers it. */
export const mealAccessLevels = ["manage", "edit", "view"] as const;
export type MealAccess = (typeof mealAccessLevels)[number];

export const mealActions = ["meals.view", "meals.plan", "meals.manage"] as const;
export type MealAction = (typeof mealActions)[number];

/** A planner context and the Home's member access, as the database reports them now. */
export type MealContextFacts =
  | { readonly context: "personal" }
  | { readonly context: "home"; readonly homeId: string; readonly memberAccess: MealMemberAccess };

const rank: { readonly [A in MealAccess]: number } = { manage: 3, edit: 2, view: 1 };
const need: { readonly [A in MealAction]: number } = {
  "meals.manage": 3,
  "meals.plan": 2,
  "meals.view": 1,
};

/**
 * The person's access to the planner: null when it is not theirs to see. For a Home, `membership`
 * is their current membership of that Home (null: none); another Home's never counts.
 */
export function mealAccess(
  context: MealContextFacts,
  membership: HomeMembershipFacts | null,
): MealAccess | null {
  if (context.context === "personal") return "manage";
  if (!decideHomeAction(context.homeId, membership, "home.meals.view").allowed) return null;
  if (decideHomeAction(context.homeId, membership, "home.meals.manage").allowed) return "manage";
  return context.memberAccess;
}

/** Whether a level (as the database answers it) allows `action`. */
export function mealAccessAllows(access: MealAccess | null, action: MealAction): boolean {
  return access !== null && rank[access] >= need[action];
}

/** Whether the person may perform `action` in the planner now. */
export function decideMealAction(
  context: MealContextFacts,
  membership: HomeMembershipFacts | null,
  action: MealAction,
): HomeDecision {
  const access = mealAccess(context, membership);
  if (access === null) return { allowed: false, reason: "not-member" };
  return mealAccessAllows(access, action)
    ? { allowed: true }
    : { allowed: false, reason: "not-permitted" };
}

export type MealPermissionProjection = { readonly [A in MealAction]: boolean };

/** Every planner action's answer for one level, for the interface. Never authoritative. */
export function mealPermissions(access: MealAccess | null): MealPermissionProjection {
  return {
    "meals.view": mealAccessAllows(access, "meals.view"),
    "meals.plan": mealAccessAllows(access, "meals.plan"),
    "meals.manage": mealAccessAllows(access, "meals.manage"),
  };
}
