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
 * Management capabilities the Owner may grant to an Administrator one at a time. Granting arrives
 * in S12; until then every Administrator's set is empty (least privilege). Owner-only powers
 * (ownership transfer, Home deletion, managing Administrators) are never in this list, so no grant
 * can confer them.
 */
export const delegableCapabilities = ["manageHomeSettings", "manageInvitations"] as const;
export type DelegableCapability = (typeof delegableCapabilities)[number];

export const homeActions = [
  "home.view",
  "home.updateSettings",
  "home.invitations.manage",
  "home.invitations.manageAdministrators",
  "home.members.view",
  "home.profile.editOwn",
] as const;
export type HomeAction = (typeof homeActions)[number];

/** The acting person's current membership of one Home, as the database reports it. */
export interface HomeMembershipFacts {
  readonly homeId: string;
  readonly role: HomeRole;
  /** What the Owner granted; only counts for Administrators. Empty until S12. */
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
    "home.invitations.manage": can("home.invitations.manage"),
    "home.invitations.manageAdministrators": can("home.invitations.manageAdministrators"),
    "home.members.view": can("home.members.view"),
    "home.profile.editOwn": can("home.profile.editOwn"),
  };
}
