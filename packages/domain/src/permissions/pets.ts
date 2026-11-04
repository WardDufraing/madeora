/**
 * Pet permissions (S31). Pure and framework-free, like ./goals.ts. The database makes the same
 * decisions on every call (`private.pet_access`, `private.pet_medical_level` in
 * supabase/migrations/*_pets.sql); the server and the interface use this module to decide what to
 * offer, never instead of those checks.
 *
 * Two separate permissions (matrix in the S31 brief; spec "Confirmed pet medical-information access
 * permissions"):
 * - Pets: every current member sees the Home's pets and their basic profile; pet managers (the
 *   Owner, Administrators granted `manageHomePets`) add, edit and delete them; restoring or purging a
 *   deleted pet also needs medical `manage` (for every pet, so it reveals nothing).
 * - Medical information (sensitive details, medical history, attachments): a per-member level,
 *   `view` or `manage`, that only the Owner has without a grant. Pet access never implies it. The
 *   Owner and Administrators granted `managePetMedicalAccess` grant and revoke it, never their own
 *   and never the Owner's.
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

export const petMedicalLevels = ["view", "manage"] as const;
export type PetMedicalLevel = (typeof petMedicalLevels)[number];

/** A level as set on a member: `none` removes the grant. */
export const petMedicalChoices = ["none", "view", "manage"] as const;
export type PetMedicalChoice = (typeof petMedicalChoices)[number];

export const petActions = [
  "pets.view",
  "pets.manage",
  "pets.medical.view",
  "pets.medical.manage",
] as const;
export type PetAction = (typeof petActions)[number];

/**
 * The person's facts in one Home: their membership (null: none) and the medical level the database
 * reports for them (null: none; the Owner's is always `manage`).
 */
export interface PetFacts {
  readonly homeId: string;
  readonly membership: HomeMembershipFacts | null;
  readonly medicalLevel: PetMedicalLevel | null;
}

/** The medical level that counts: the Owner always manages; a grant counts only for a member. */
export function effectiveMedicalLevel(facts: PetFacts): PetMedicalLevel | null {
  if (facts.membership?.homeId !== facts.homeId) return null;
  if (facts.membership.role === "owner") return "manage";
  return facts.medicalLevel;
}

/** Whether the person may perform `action` with the Home's pets now. */
export function decidePetAction(facts: PetFacts, action: PetAction): HomeDecision {
  const view = decideHomeAction(facts.homeId, facts.membership, "home.pets.view");
  if (!view.allowed) return view;
  const level = effectiveMedicalLevel(facts);
  const allowed =
    action === "pets.view"
      ? true
      : action === "pets.manage"
        ? decideHomeAction(facts.homeId, facts.membership, "home.pets.manage").allowed
        : action === "pets.medical.view"
          ? level !== null
          : level === "manage";
  return allowed ? { allowed: true } : { allowed: false, reason: "not-permitted" };
}

export type PetPermissionProjection = { readonly [A in PetAction]: boolean };

/** Every pet action's answer for one person, for the interface. Never authoritative. */
export function petPermissions(facts: PetFacts): PetPermissionProjection {
  const can = (action: PetAction) => decidePetAction(facts, action).allowed;
  return {
    "pets.view": can("pets.view"),
    "pets.manage": can("pets.manage"),
    "pets.medical.view": can("pets.medical.view"),
    "pets.medical.manage": can("pets.medical.manage"),
  };
}

/**
 * Whether `grantor` may change `target`'s medical level in the Home: the Owner or an Administrator
 * granted `managePetMedicalAccess`, for another member who is not the Owner.
 */
export function canChangeMedicalAccess(
  homeId: string,
  grantor: HomeMembershipFacts | null,
  target: { readonly role: HomeMembershipFacts["role"]; readonly isSelf: boolean },
): boolean {
  if (!decideHomeAction(homeId, grantor, "home.pets.grantMedicalAccess").allowed) return false;
  return !target.isSelf && target.role !== "owner";
}

export const petCareActions = [
  "care.view",
  "care.readTexts",
  "care.complete",
  "care.edit",
  "care.manage",
  "care.skip",
  "care.correct",
  "care.reopen",
] as const;
export type PetCareAction = (typeof petCareActions)[number];

/** What is known about one care activity or occurrence for the decision. */
export interface PetCareFacts {
  /** The activity has medical details (always for medication). */
  readonly medical: boolean;
  /** The person is responsible for the occurrence. */
  readonly responsible?: boolean;
  /** The person recorded the occurrence's completion or skip. */
  readonly recordedBySelf?: boolean;
}

/**
 * Whether the person may perform `action` on a pet-care activity or occurrence (S31 care part; the
 * database decides the same in supabase/migrations/*_pet_care.sql):
 * - every member sees care and completes any occurrence; the texts of an activity with medical
 *   details only with medical view (`care.readTexts`);
 * - pet managers pause, resume, end and change single occurrences (`care.manage`), and create, edit
 *   and delete activities (`care.edit`), which for medical details needs medical manage too;
 * - a responsible member or a pet manager skips; whoever recorded it or a pet manager reopens, and
 *   corrects when they may read the texts.
 */
export function decidePetCareAction(
  facts: PetFacts,
  care: PetCareFacts,
  action: PetCareAction,
): HomeDecision {
  const view = decidePetAction(facts, "pets.view");
  if (!view.allowed) return view;
  const manager = decidePetAction(facts, "pets.manage").allowed;
  const readTexts = !care.medical || decidePetAction(facts, "pets.medical.view").allowed;
  const allowed = (() => {
    switch (action) {
      case "care.view":
      case "care.complete":
        return true;
      case "care.readTexts":
        return readTexts;
      case "care.edit":
        return manager && (!care.medical || decidePetAction(facts, "pets.medical.manage").allowed);
      case "care.manage":
        return manager;
      case "care.skip":
        return manager || care.responsible === true;
      case "care.reopen":
        return manager || care.recordedBySelf === true;
      case "care.correct":
        return (manager || care.recordedBySelf === true) && readTexts;
    }
  })();
  return allowed ? { allowed: true } : { allowed: false, reason: "not-permitted" };
}
