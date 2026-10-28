/**
 * The Home permission engine (architecture.md §4, authorization strategy C; spec "Confirmed Home
 * roles", "Confirmed exactly one Home Owner", "Confirmed customizable Administrator permissions").
 *
 * Pure and framework-free: no database, no secrets, no I/O. Server code loads the acting person's
 * membership with their own Supabase session and asks this module before every Home action; the
 * database's RLS makes the same decision independently, so neither is the only line of defence.
 * The browser may use `homePermissions` to decide what to show, never to decide what is allowed.
 *
 * Add an action here, with its rule, before any code performs it, and keep the matching RLS policy
 * in the same change. The per-module permission matrix is still open in the spec: do not add
 * module actions or Administrator defaults without the owner's decision.
 */

export const homeRoles = ["owner", "administrator", "member"] as const;
export type HomeRole = (typeof homeRoles)[number];

export function isHomeRole(value: unknown): value is HomeRole {
  return typeof value === "string" && (homeRoles as readonly string[]).includes(value);
}

/**
 * Management capabilities the Owner may grant to an Administrator one at a time (S12). A new
 * Administrator holds none (least privilege). Owner-only powers (ownership transfer, Home deletion,
 * managing Administrators and their capabilities) are never in this list, so no grant can confer
 * them. The SQL function private.is_delegable_capability lists the same names.
 */
export const delegableCapabilities = [
  "manageHomeSettings",
  "manageInvitations",
  "removeMembers",
  "manageHomeDashboard",
  "manageHomeTasks",
  "manageHomeChores",
  "approveHomeChores",
  "manageHomeRewards",
  "approveHomeRewards",
  "manageHomePoints",
  "manageHomeRecipes",
  "manageHomeShopping",
  "manageHomeMeals",
] as const;
export type DelegableCapability = (typeof delegableCapabilities)[number];

export const homeActions = [
  "home.view",
  "home.updateSettings",
  "home.storage.view",
  "home.trash.view",
  "home.trash.viewAll",
  "home.invitations.manage",
  "home.invitations.manageAdministrators",
  "home.members.view",
  "home.profile.editOwn",
  "home.members.manageRoles",
  "home.members.manageCapabilities",
  "home.members.remove",
  "home.leave",
  "home.ownership.transfer",
  "home.recovery.request",
  "home.recovery.cancel",
  "home.recovery.object",
  "home.dashboard.view",
  "home.dashboard.edit",
  "home.tasks.view",
  "home.tasks.create",
  "home.tasks.comment",
  "home.tasks.manage",
  "home.chores.view",
  "home.chores.complete",
  "home.chores.manage",
  "home.chores.review",
  "home.points.view",
  "home.points.manage",
  "home.rewards.manage",
  "home.rewards.approve",
  "home.recipes.view",
  "home.recipes.create",
  "home.recipes.manage",
  "home.shopping.view",
  "home.shopping.create",
  "home.shopping.manage",
  "home.meals.view",
  "home.meals.manage",
] as const;
export type HomeAction = (typeof homeActions)[number];

/** The acting person's current membership of one Home, as the database reports it. */
export interface HomeMembershipFacts {
  readonly homeId: string;
  readonly role: HomeRole;
  /** What the Owner granted; only counts for Administrators. */
  readonly grantedCapabilities: ReadonlySet<DelegableCapability>;
}

export type HomeDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** `not-member`: no current membership of this Home; `not-permitted`: the role or grants
       * do not include the action. Callers must not reveal the difference to the person when it
       * would disclose that a Home exists. */
      readonly reason: "not-member" | "not-permitted";
    };

interface Rule {
  /** Roles that may always perform the action. */
  readonly roles: readonly HomeRole[];
  /** A capability that lets an Administrator perform it when the Owner granted it. */
  readonly delegatedThrough?: DelegableCapability;
}

const rules: { readonly [A in HomeAction]: Rule } = {
  // Every current member sees the Home they belong to.
  "home.view": { roles: ["owner", "administrator", "member"] },
  // Name and scheduling timezone (spec: managed only by authorized Home managers).
  "home.updateSettings": { roles: ["owner"], delegatedThrough: "manageHomeSettings" },
  // The Home's storage use and its 80%/95% warnings (S15; spec "Confirmed progressive storage
  // warnings": only authorized Home storage managers). Storage is a Home setting, so the same
  // grant reaches it (SQL: private.can_view_home_storage).
  "home.storage.view": { roles: ["owner"], delegatedThrough: "manageHomeSettings" },
  // The Home's trash (S16; spec "Confirmed central personal and Home trash organization"). Every
  // current member may open it, but sees only what they deleted themselves; the Owner and
  // Administrators granted manageHomeSettings see everything in it. The database applies the same
  // rule (SQL: private.can_see_trash_entry). The per-module matrix is open in the spec, so a module
  // step may refine it for its own item type.
  "home.trash.view": { roles: ["owner", "administrator", "member"] },
  "home.trash.viewAll": { roles: ["owner"], delegatedThrough: "manageHomeSettings" },
  // Member invitations, links and join codes, and deciding Member join requests (S10). The SQL
  // function private.can_manage_invitations makes the same decision for every database call.
  "home.invitations.manage": { roles: ["owner"], delegatedThrough: "manageInvitations" },
  // Inviting or admitting Administrators: assigning Administrators is a non-delegable Owner power
  // (spec "Confirmed customizable Administrator permissions"), so no capability reaches it.
  "home.invitations.manageAdministrators": { roles: ["owner"] },
  // The member directory (S11): every current member sees who else belongs to the Home, with only
  // the effective name, colour and role (SQL: public.home_directory).
  "home.members.view": { roles: ["owner", "administrator", "member"] },
  // Your own nickname, Home display name and accent in this Home (S11). Only ever your own: no
  // action exists to edit another adult's presentation, and RLS allows only the person's own row.
  "home.profile.editOwn": { roles: ["owner", "administrator", "member"] },
  // Making Members Administrators and back (S12): assigning and removing Administrators is a
  // non-delegable Owner power (SQL: public.change_home_member_role).
  "home.members.manageRoles": { roles: ["owner"] },
  // Granting and revoking an Administrator's capabilities: Owner only, never delegable (SQL:
  // public.set_administrator_capabilities).
  "home.members.manageCapabilities": { roles: ["owner"] },
  // Removing someone: the Owner, or an Administrator granted removeMembers. Who may be removed
  // depends on the target too: see decideMemberAction (SQL: public.remove_home_member).
  "home.members.remove": { roles: ["owner"], delegatedThrough: "removeMembers" },
  // Leaving without anyone's approval; the Owner must hand over ownership first (SQL:
  // public.leave_home).
  "home.leave": { roles: ["administrator", "member"] },
  // Nominating the next Owner, and cancelling the nomination (SQL: start_ownership_transfer).
  "home.ownership.transfer": { roles: ["owner"] },
  // Asking Madeora to review a takeover when the Owner cannot be reached (S12b; spec "Confirmed
  // verified Home ownership recovery"). The role is only the start: the database also requires a
  // confirmed account and 30 days of membership, and staff verify the person outside the app.
  // No capability or role ever approves a takeover (SQL: public.request_ownership_recovery).
  "home.recovery.request": { roles: ["administrator", "member"] },
  // The Owner, evidently able to sign in, ends every open recovery request about their Home
  // (SQL: public.cancel_ownership_recoveries).
  "home.recovery.cancel": { roles: ["owner"] },
  // Any adult member may object to an open recovery; the case pauses for staff (SQL:
  // public.object_to_ownership_recovery).
  "home.recovery.object": { roles: ["owner", "administrator", "member"] },
  // The Home's shared dashboard (S17; spec "Confirmed dashboard ownership"): every current member
  // sees it; the Owner, and Administrators granted manageHomeDashboard, arrange it and apply or share
  // Home-dashboard templates (owner decision, 2026-10-16). SQL: private.can_edit_home_dashboard.
  "home.dashboard.view": { roles: ["owner", "administrator", "member"] },
  "home.dashboard.edit": { roles: ["owner"], delegatedThrough: "manageHomeDashboard" },
  // Home tasks (S18; default picked in the S18 brief, the per-module matrix is open in the spec):
  // every current member sees the Home's lists, tasks, labels and comments, creates tasks and
  // comments; task managers (the Owner, Administrators granted manageHomeTasks) set assignees
  // (spec: "the Home task-management permission"), manage lists and labels and edit or delete any
  // task. Per-task rights (creator, assignee) are in ./tasks.ts. SQL: private.can_manage_tasks.
  "home.tasks.view": { roles: ["owner", "administrator", "member"] },
  "home.tasks.create": { roles: ["owner", "administrator", "member"] },
  "home.tasks.comment": { roles: ["owner", "administrator", "member"] },
  "home.tasks.manage": { roles: ["owner"], delegatedThrough: "manageHomeTasks" },
  // Home chores (S20; default picked in the S20 brief, the per-module matrix is open in the spec):
  // every current member sees the Home's chores, their checklists, notes and history, ticks
  // checklist steps and completes any occurrence, naming who actually did it (spec "Confirmed
  // completion of another member's chore"); chore managers (the Owner, Administrators granted
  // manageHomeChores) create, edit, pause and delete chores, skip and reopen occurrences and manage
  // categories. SQL: private.can_manage_chores. Reviewing completions of chores that require
  // approval is its own explicit permission (spec "Confirmed self-approval of chore completions":
  // ordinary completion rights never review; a reviewer may approve their own completion): the
  // Owner, and Administrators granted approveHomeChores. SQL: private.can_review_chores.
  "home.chores.view": { roles: ["owner", "administrator", "member"] },
  "home.chores.complete": { roles: ["owner", "administrator", "member"] },
  "home.chores.manage": { roles: ["owner"], delegatedThrough: "manageHomeChores" },
  "home.chores.review": { roles: ["owner"], delegatedThrough: "approveHomeChores" },
  // Points and rewards (S23; defaults picked in the S23 brief, the per-module matrix is open in the
  // spec): every current member sees their own balance and ledger, the enabled reward catalog,
  // redeems and requests, cancels their own request, sees the leaderboard when the Home turned it on
  // and sets their own participation and weekly target. Balances are private (spec "Confirmed reward
  // balance privacy"): only points managers (the Owner, Administrators granted manageHomePoints) see
  // other members' balances and ledgers and post bonuses, corrections and reversals; together with
  // home.chores.manage they also correct or reopen completions that change awarded points. Rewards
  // managers (manageHomeRewards) manage the catalog, limits, the leaderboard settings, fulfillment
  // and its resolutions, and cancel someone else's request. Reviewers (approveHomeRewards) approve or
  // reject requests, never their own (spec "Confirmed independent reviewer for reward redemptions":
  // ./points.ts decides that per request). SQL: private.can_manage_points, can_manage_rewards,
  // can_approve_rewards.
  "home.points.view": { roles: ["owner", "administrator", "member"] },
  "home.points.manage": { roles: ["owner"], delegatedThrough: "manageHomePoints" },
  "home.rewards.manage": { roles: ["owner"], delegatedThrough: "manageHomeRewards" },
  "home.rewards.approve": { roles: ["owner"], delegatedThrough: "approveHomeRewards" },
  // Recipes (S24; default picked in the S24 brief, the per-module matrix is open in the spec):
  // every current member sees the Home's published recipes, searches, scales and cooks them, keeps
  // their own favorites and ratings, and creates and publishes recipes into the Home; a recipe's
  // creator (while a member) and recipe managers (the Owner, Administrators granted
  // manageHomeRecipes) edit it under the exclusive lock and delete it to the trash. Drafts are never
  // a Home's: only their creator sees them (./recipes.ts). SQL: private.can_manage_recipes.
  "home.recipes.view": { roles: ["owner", "administrator", "member"] },
  "home.recipes.create": { roles: ["owner", "administrator", "member"] },
  "home.recipes.manage": { roles: ["owner"], delegatedThrough: "manageHomeRecipes" },
  // Shopping (S26; default picked in the S26 brief, the per-module matrix is open in the spec):
  // every current member sees the Home's lists and creates lists; shopping managers (the Owner,
  // Administrators granted manageHomeShopping) manage every list and the order of the Home's lists.
  // A list's creator manages their own list while a member, and the list's member access decides
  // what everyone else may do in it (./shopping.ts). SQL: private.can_manage_shopping,
  // private.shopping_access.
  "home.shopping.view": { roles: ["owner", "administrator", "member"] },
  "home.shopping.create": { roles: ["owner", "administrator", "member"] },
  "home.shopping.manage": { roles: ["owner"], delegatedThrough: "manageHomeShopping" },
  // Meal planner (S27; default picked in the S27 brief, the per-module matrix is open in the spec):
  // every current member sees and prints the Home's plan and plans meals unless a meal manager set
  // the planner to view only (./meals.ts); meal managers (the Owner, Administrators granted
  // manageHomeMeals) always plan, configure slots and set that member access. SQL:
  // private.meal_access.
  "home.meals.view": { roles: ["owner", "administrator", "member"] },
  "home.meals.manage": { roles: ["owner"], delegatedThrough: "manageHomeMeals" },
};

const allowed: HomeDecision = { allowed: true };

/**
 * Whether the holder of `membership` may perform `action` in the Home `homeId`. A missing
 * membership, or one that belongs to another Home, is never enough.
 */
export function decideHomeAction(
  homeId: string,
  membership: HomeMembershipFacts | null,
  action: HomeAction,
): HomeDecision {
  if (membership?.homeId !== homeId) return { allowed: false, reason: "not-member" };
  const rule = rules[action];
  if (rule.roles.includes(membership.role)) return allowed;
  if (
    membership.role === "administrator" &&
    rule.delegatedThrough !== undefined &&
    membership.grantedCapabilities.has(rule.delegatedThrough)
  ) {
    return allowed;
  }
  return { allowed: false, reason: "not-permitted" };
}

export type HomePermissionProjection = { readonly [A in HomeAction]: boolean };

/** Every action's decision for one membership, for showing or hiding controls. Never authoritative. */
export function homePermissions(membership: HomeMembershipFacts): HomePermissionProjection {
  const can = (action: HomeAction) =>
    decideHomeAction(membership.homeId, membership, action).allowed;
  // Listed one by one so a new action fails the type check until it is added here.
  return {
    "home.view": can("home.view"),
    "home.updateSettings": can("home.updateSettings"),
    "home.storage.view": can("home.storage.view"),
    "home.trash.view": can("home.trash.view"),
    "home.trash.viewAll": can("home.trash.viewAll"),
    "home.invitations.manage": can("home.invitations.manage"),
    "home.invitations.manageAdministrators": can("home.invitations.manageAdministrators"),
    "home.members.view": can("home.members.view"),
    "home.profile.editOwn": can("home.profile.editOwn"),
    "home.members.manageRoles": can("home.members.manageRoles"),
    "home.members.manageCapabilities": can("home.members.manageCapabilities"),
    "home.members.remove": can("home.members.remove"),
    "home.leave": can("home.leave"),
    "home.ownership.transfer": can("home.ownership.transfer"),
    "home.recovery.request": can("home.recovery.request"),
    "home.recovery.cancel": can("home.recovery.cancel"),
    "home.recovery.object": can("home.recovery.object"),
    "home.dashboard.view": can("home.dashboard.view"),
    "home.dashboard.edit": can("home.dashboard.edit"),
    "home.tasks.view": can("home.tasks.view"),
    "home.tasks.create": can("home.tasks.create"),
    "home.tasks.comment": can("home.tasks.comment"),
    "home.tasks.manage": can("home.tasks.manage"),
    "home.chores.view": can("home.chores.view"),
    "home.chores.complete": can("home.chores.complete"),
    "home.chores.manage": can("home.chores.manage"),
    "home.chores.review": can("home.chores.review"),
    "home.points.view": can("home.points.view"),
    "home.points.manage": can("home.points.manage"),
    "home.rewards.manage": can("home.rewards.manage"),
    "home.rewards.approve": can("home.rewards.approve"),
    "home.recipes.view": can("home.recipes.view"),
    "home.recipes.create": can("home.recipes.create"),
    "home.recipes.manage": can("home.recipes.manage"),
    "home.shopping.view": can("home.shopping.view"),
    "home.shopping.create": can("home.shopping.create"),
    "home.shopping.manage": can("home.shopping.manage"),
    "home.meals.view": can("home.meals.view"),
    "home.meals.manage": can("home.meals.manage"),
  };
}

/** Actions one member performs on another member of the same Home (S12). */
export const memberActions = [
  "member.changeRole",
  "member.editCapabilities",
  "member.remove",
  "member.nominateOwner",
] as const;
export type MemberAction = (typeof memberActions)[number];

/** The member acted on, as the database reports them now. */
export interface MemberTargetFacts {
  readonly homeId: string;
  readonly role: HomeRole;
  /** Whether the target is the acting person themselves. */
  readonly isSelf: boolean;
}

/**
 * Whether the holder of `actor` may perform `action` on `target` in the Home `homeId` (spec
 * "Confirmed Home member-removal authority", "Confirmed customizable Administrator permissions",
 * "Confirmed Home ownership transfer"):
 * - nobody acts on the Owner, and nobody acts on themselves this way (you leave instead);
 * - role changes and capability edits are Owner-only, capabilities only for Administrators;
 * - the Owner removes Members and Administrators; an Administrator granted removeMembers removes
 *   Members only;
 * - only the Owner nominates the next Owner, from the Home's other members.
 * The database functions make the same decisions under a lock, with the target's current role.
 */
export function decideMemberAction(
  homeId: string,
  actor: HomeMembershipFacts | null,
  target: MemberTargetFacts,
  action: MemberAction,
): HomeDecision {
  if (actor?.homeId !== homeId || target.homeId !== homeId) {
    return { allowed: false, reason: "not-member" };
  }
  const denied: HomeDecision = { allowed: false, reason: "not-permitted" };
  if (target.isSelf || target.role === "owner") return denied;
  const homeAction = (name: HomeAction) => decideHomeAction(homeId, actor, name).allowed;
  switch (action) {
    case "member.changeRole":
      return homeAction("home.members.manageRoles") ? allowed : denied;
    case "member.editCapabilities":
      return target.role === "administrator" && homeAction("home.members.manageCapabilities")
        ? allowed
        : denied;
    case "member.remove":
      if (!homeAction("home.members.remove")) return denied;
      return actor.role === "owner" || target.role === "member" ? allowed : denied;
    case "member.nominateOwner":
      return homeAction("home.ownership.transfer") ? allowed : denied;
  }
}

export type MemberPermissionProjection = { readonly [A in MemberAction]: boolean };

/** Every member action's decision for one actor and target, for the interface. Never authoritative. */
export function memberPermissions(
  actor: HomeMembershipFacts,
  target: MemberTargetFacts,
): MemberPermissionProjection {
  const can = (action: MemberAction) =>
    decideMemberAction(actor.homeId, actor, target, action).allowed;
  return {
    "member.changeRole": can("member.changeRole"),
    "member.editCapabilities": can("member.editCapabilities"),
    "member.remove": can("member.remove"),
    "member.nominateOwner": can("member.nominateOwner"),
  };
}

/** Narrows a string to a delegable capability. */
export function isDelegableCapability(value: unknown): value is DelegableCapability {
  return typeof value === "string" && (delegableCapabilities as readonly string[]).includes(value);
}
