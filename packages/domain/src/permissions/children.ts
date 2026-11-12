/**
 * Child profiles and guardians (S41). Pure and framework-free, like ./pets.ts. The database makes
 * the same decisions on every call (`public.create_child`, `public.assign_child_guardian`,
 * `public.remove_child_secondary_guardian`, `public.set_child_access`,
 * `public.set_child_presentation` in supabase/migrations/*_child_profiles.sql); the server and the
 * interface use this module to decide what to offer and to preview access changes, never instead
 * of those checks.
 *
 * Rules (spec "Confirmed guardian roles", "Confirmed age-appropriate child permission presets";
 * S41 brief):
 * - Each child has, per Home, one primary guardian and at most one secondary guardian. Being Owner
 *   or Administrator grants no guardian authority; while the child has no primary guardian (on
 *   hold) the Owner may only ask another adult to take the role, never themselves.
 * - The primary guardian offers the secondary role and removes the secondary, offers the primary
 *   role (hand-over), issues the code that links the child to another Home, changes the preset
 *   and widens access (after an explicit before/after confirmation). Guardian roles apply only
 *   when the named adult accepts.
 * - The secondary guardian manages routine things: name and colour in the Home, switching
 *   capabilities off, stepping down. Never widening access or changing the preset.
 * - Presets never follow age or birthdays; a new child always starts on Young Child.
 */

/** What a child can be allowed in one Home. `private.child_capabilities()` lists the same. */
export const childCapabilities = [
  "viewHomeChores",
  "viewHomeCalendar",
  "viewLeaderboard",
  "claimPoolChores",
  "redeemRewards",
  "viewShopping",
  "editShopping",
  "viewMeals",
  "viewRecipes",
  "viewPets",
  "editOwnAvatar",
  "editOwnDisplayName",
] as const;
export type ChildCapability = (typeof childCapabilities)[number];

export function isChildCapability(value: unknown): value is ChildCapability {
  return typeof value === "string" && (childCapabilities as readonly string[]).includes(value);
}

export const childPresets = ["young_child", "child", "teen"] as const;
export type ChildPreset = (typeof childPresets)[number];

/** The restrictive preset every new child starts on (spec; Ward, 2026-11-11). */
export const DEFAULT_CHILD_PRESET: ChildPreset = "young_child";

export const childAgeBands = ["under_8", "8_12", "13_17"] as const;
export type ChildAgeBand = (typeof childAgeBands)[number];

/** `private.child_preset_capabilities(preset)` lists the same. */
export const childPresetCapabilities: { readonly [P in ChildPreset]: readonly ChildCapability[] } =
  {
    young_child: ["viewHomeChores", "viewHomeCalendar", "viewLeaderboard"],
    child: [
      "viewHomeChores",
      "viewHomeCalendar",
      "viewLeaderboard",
      "claimPoolChores",
      "redeemRewards",
      "viewShopping",
      "viewMeals",
      "viewRecipes",
      "viewPets",
      "editOwnAvatar",
    ],
    teen: [
      "viewHomeChores",
      "viewHomeCalendar",
      "viewLeaderboard",
      "claimPoolChores",
      "redeemRewards",
      "viewShopping",
      "editShopping",
      "viewMeals",
      "viewRecipes",
      "viewPets",
      "editOwnAvatar",
      "editOwnDisplayName",
    ],
  };

/**
 * The preset an age band suggests. Only a suggestion shown to the guardian: creation always uses
 * {@link DEFAULT_CHILD_PRESET} and nothing changes on its own (Ward, 2026-11-11).
 */
export function suggestedPreset(ageBand: ChildAgeBand | null): ChildPreset {
  if (ageBand === "8_12") return "child";
  if (ageBand === "13_17") return "teen";
  return "young_child";
}

/** Explicit per-child switches on top of the preset. */
export type ChildOverrides = Partial<Readonly<Record<ChildCapability, boolean>>>;

/** The capabilities that apply: the preset's, each override switching one on or off. Sorted. */
export function effectiveChildCapabilities(
  preset: ChildPreset,
  overrides: ChildOverrides,
): readonly ChildCapability[] {
  const fromPreset = new Set<ChildCapability>(childPresetCapabilities[preset]);
  return childCapabilities
    .filter((capability) => overrides[capability] ?? fromPreset.has(capability))
    .sort();
}

export interface ChildAccessChange {
  readonly added: readonly ChildCapability[];
  readonly removed: readonly ChildCapability[];
  /** Any capability is added: the change needs explicit confirmation. */
  readonly widens: boolean;
}

/** The before/after preview shown before a preset or override change. */
export function compareChildAccess(
  before: readonly ChildCapability[],
  after: readonly ChildCapability[],
): ChildAccessChange {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((capability) => !beforeSet.has(capability));
  const removed = before.filter((capability) => !afterSet.has(capability));
  return { added, removed, widens: added.length > 0 };
}

export type GuardianRole = "primary" | "secondary";

export const childActions = [
  "child.access.change",
  "child.access.restrict",
  "child.presentation.change",
  "child.guardian.assignSecondary",
  "child.guardian.handOverPrimary",
  "child.guardian.appointPrimary",
  "child.guardian.removeSecondary",
  "child.link.issue",
  "child.remove",
  // S42: username, password and turning sign-in on (primary-only sensitive authority).
  "child.signIn.manage",
  // S42: PIN resets, turning sign-in off, unlocking, signing out everywhere (either guardian).
  "child.signIn.assist",
] as const;
export type ChildAction = (typeof childActions)[number];

export interface ChildFacts {
  /** The person's role in the Home, or null when they are not a member. */
  readonly homeRole: "owner" | "administrator" | "member" | null;
  /** The person's guardian role for this child in this Home, or null. */
  readonly guardianRole: GuardianRole | null;
  /** Whether the child currently has a primary guardian in this Home. */
  readonly hasPrimaryGuardian: boolean;
}

/** Whether the person may perform `action` for this child in this Home. */
export function decideChildAction(facts: ChildFacts, action: ChildAction): boolean {
  if (facts.homeRole === null) return false;
  const primary = facts.guardianRole === "primary";
  const guardian = facts.guardianRole !== null;
  switch (action) {
    case "child.access.change":
    case "child.signIn.manage":
    case "child.guardian.assignSecondary":
    case "child.guardian.handOverPrimary":
    case "child.link.issue":
      return primary;
    case "child.access.restrict":
    case "child.signIn.assist":
    case "child.presentation.change":
    case "child.guardian.removeSecondary":
      return guardian;
    case "child.guardian.appointPrimary":
      return !facts.hasPrimaryGuardian && facts.homeRole === "owner";
    case "child.remove":
      return primary || facts.homeRole === "owner";
  }
}

export type ChildPermissionProjection = { readonly [A in ChildAction]: boolean };

/** Every child action's answer for one person, for the interface. Never authoritative. */
export function childPermissions(facts: ChildFacts): ChildPermissionProjection {
  const can = (action: ChildAction) => decideChildAction(facts, action);
  return {
    "child.access.change": can("child.access.change"),
    "child.access.restrict": can("child.access.restrict"),
    "child.presentation.change": can("child.presentation.change"),
    "child.guardian.assignSecondary": can("child.guardian.assignSecondary"),
    "child.guardian.handOverPrimary": can("child.guardian.handOverPrimary"),
    "child.guardian.appointPrimary": can("child.guardian.appointPrimary"),
    "child.guardian.removeSecondary": can("child.guardian.removeSecondary"),
    "child.link.issue": can("child.link.issue"),
    "child.remove": can("child.remove"),
    "child.signIn.manage": can("child.signIn.manage"),
    "child.signIn.assist": can("child.signIn.assist"),
  };
}
