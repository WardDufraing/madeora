/**
 * Shopping list permissions (S26). Pure and framework-free, like ./home.ts. The database makes the
 * same decisions on every call (`private.shopping_access`, `private.shopping_may`,
 * `private.can_manage_shopping` in supabase/migrations/*_shopping_lists.sql); the server and the
 * interface use this module to decide what to offer, never instead of those checks.
 *
 * Default picked in the S26 brief (the per-module permission matrix is open in the spec; the owner
 * may override):
 * - Personal space: its owner does everything with its lists.
 * - Home: every current member sees every list and creates lists. A list's managers are its
 *   creator (while a member) and shopping managers (the Owner, Administrators granted
 *   `manageHomeShopping`): they rename it, set its member access, archive, restore and delete it.
 *   Everyone else gets the list's member access: `edit` (default), `check` (check off only) or
 *   `view` (read only). Reordering a context's lists is for shopping managers.
 * - An archived list is read only for everyone until a manager restores it.
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

export const shoppingMemberAccess = ["edit", "check", "view"] as const;
export type ShoppingMemberAccess = (typeof shoppingMemberAccess)[number];

/** What a person may do with one list, as `private.shopping_access` answers it. */
export const shoppingAccessLevels = ["manage", "edit", "check", "view"] as const;
export type ShoppingAccess = (typeof shoppingAccessLevels)[number];

export const shoppingActions = [
  "shopping.view",
  "shopping.check",
  "shopping.edit",
  "shopping.manage",
] as const;
export type ShoppingAction = (typeof shoppingActions)[number];

/** A list and the acting person's relation to it, as the database reports them now. */
export type ShoppingListFacts =
  | { readonly context: "personal"; readonly ownedByMe: boolean; readonly archived: boolean }
  | {
      readonly context: "home";
      readonly homeId: string;
      readonly createdByMe: boolean;
      readonly memberAccess: ShoppingMemberAccess;
      readonly archived: boolean;
    };

const rank: { readonly [A in ShoppingAccess]: number } = { manage: 4, edit: 3, check: 2, view: 1 };
const need: { readonly [A in ShoppingAction]: number } = {
  "shopping.manage": 4,
  "shopping.edit": 3,
  "shopping.check": 2,
  "shopping.view": 1,
};

/**
 * The person's access to the list: null when it is not theirs to see. For a Home list,
 * `membership` is their current membership of that Home (null: none); another Home's never counts.
 */
export function shoppingAccess(
  list: ShoppingListFacts,
  membership: HomeMembershipFacts | null,
): ShoppingAccess | null {
  if (list.context === "personal") return list.ownedByMe ? "manage" : null;
  if (!decideHomeAction(list.homeId, membership, "home.shopping.view").allowed) return null;
  if (
    list.createdByMe ||
    decideHomeAction(list.homeId, membership, "home.shopping.manage").allowed
  ) {
    return "manage";
  }
  return list.memberAccess;
}

/** Whether the person may perform `action` on the list now. */
export function decideShoppingAction(
  list: ShoppingListFacts,
  membership: HomeMembershipFacts | null,
  action: ShoppingAction,
): HomeDecision {
  const access = shoppingAccess(list, membership);
  if (access === null) return { allowed: false, reason: "not-member" };
  if (rank[access] < need[action]) return { allowed: false, reason: "not-permitted" };
  // Archived: read only, but its managers may still restore, rename or delete it.
  if (list.archived && (action === "shopping.check" || action === "shopping.edit")) {
    return { allowed: false, reason: "not-permitted" };
  }
  return { allowed: true };
}

/** What a level (as the database answers it) allows, for an active or archived list. */
export function accessAllows(
  access: ShoppingAccess,
  archived: boolean,
  action: ShoppingAction,
): boolean {
  if (rank[access] < need[action]) return false;
  return !(archived && (action === "shopping.check" || action === "shopping.edit"));
}

export type ShoppingPermissionProjection = { readonly [A in ShoppingAction]: boolean };

/** Every shopping action's answer for one person and list, for the interface. Never authoritative. */
export function shoppingPermissions(
  list: ShoppingListFacts,
  membership: HomeMembershipFacts | null,
): ShoppingPermissionProjection {
  const can = (action: ShoppingAction) => decideShoppingAction(list, membership, action).allowed;
  return {
    "shopping.view": can("shopping.view"),
    "shopping.check": can("shopping.check"),
    "shopping.edit": can("shopping.edit"),
    "shopping.manage": can("shopping.manage"),
  };
}
