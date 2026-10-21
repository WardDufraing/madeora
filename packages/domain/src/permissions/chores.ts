/**
 * Chore permissions (S20). Pure and framework-free, like ./home.ts. The database makes the same
 * decisions on every call (`private.can_manage_chores` and the chore functions in
 * supabase/migrations/*_chores.sql); the server and the interface use this module to decide what to
 * offer, never instead of those checks.
 *
 * Default picked in the S20 brief (the per-module permission matrix is open in the spec; the owner
 * may override):
 * - Chores are Home-only. Every current member sees the Home's chores, their checklists, completion
 *   notes and history, ticks checklist steps and completes any open occurrence, naming who actually
 *   did it (spec "Confirmed completion of another member's chore").
 * - Chore managers (the Owner, and Administrators granted `manageHomeChores`) create and edit
 *   chores in every scope, pause, resume and delete them, skip and reopen occurrences, and manage
 *   the Home's chore categories and templates, apply bulk occurrence actions, turn approval on
 *   per chore, and correct completed records. The person who created a chore has no extra rights.
 * - Chore reviewers (the Owner, and Administrators granted `approveHomeChores`) approve or reject
 *   submitted completions, including their own (spec "Confirmed self-approval"). Managing chores
 *   never implies reviewing them.
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

export const choreActions = [
  "chore.view",
  "chore.complete",
  "chore.tickStep",
  "chore.skip",
  "chore.reopen",
  "chore.edit",
  "chore.pause",
  "chore.delete",
  "chore.manageCategories",
  "chore.manageTemplates",
  "chore.bulk",
  "chore.correct",
  "chore.review",
  "chore.claim",
  "chore.release",
  "chore.requestReassignment",
  "chore.propose",
  "chore.respondVolunteer",
  "chore.remind",
  "chore.setClaimPolicy",
  "chore.configure",
  "chore.reviewProposal",
  "chore.requestVolunteer",
  "chore.correctVolunteer",
  "chore.handoverForOthers",
  "chore.move",
  "chore.summary",
] as const;
export type ChoreAction = (typeof choreActions)[number];

/** Where a chore lives, as the database reports it now. */
export interface ChoreFacts {
  readonly homeId: string;
}

const allowed: HomeDecision = { allowed: true };
const refused: HomeDecision = { allowed: false, reason: "not-permitted" };

/**
 * Whether the person may perform `action` on a chore of the Home `chore.homeId`. `membership` is
 * their current membership of that Home (null: none); a membership of another Home never counts.
 */
export function decideChoreAction(
  chore: ChoreFacts,
  membership: HomeMembershipFacts | null,
  action: ChoreAction,
): HomeDecision {
  const view = decideHomeAction(chore.homeId, membership, "home.chores.view");
  if (!view.allowed) return view;
  switch (action) {
    case "chore.view":
      return allowed;
    // S21: every current member claims from the pool, hands over their own chore, proposes a chore,
    // answers a volunteer invitation and sets a personal reminder (the database narrows each to the
    // person's own chores and invitations).
    case "chore.claim":
    case "chore.release":
    case "chore.requestReassignment":
    case "chore.propose":
    case "chore.respondVolunteer":
    case "chore.remind":
      return allowed;
    case "chore.complete":
    case "chore.tickStep":
      return decideHomeAction(chore.homeId, membership, "home.chores.complete");
    case "chore.skip":
    case "chore.reopen":
    case "chore.edit":
    case "chore.pause":
    case "chore.delete":
    case "chore.manageCategories":
    case "chore.manageTemplates":
    case "chore.bulk":
    case "chore.correct":
    case "chore.setClaimPolicy":
    case "chore.configure":
    case "chore.reviewProposal":
    case "chore.requestVolunteer":
    case "chore.correctVolunteer":
    case "chore.handoverForOthers":
    case "chore.move":
    case "chore.summary":
      return decideHomeAction(chore.homeId, membership, "home.chores.manage").allowed
        ? allowed
        : refused;
    case "chore.review":
      return decideHomeAction(chore.homeId, membership, "home.chores.review").allowed
        ? allowed
        : refused;
  }
}

export type ChorePermissionProjection = { readonly [A in ChoreAction]: boolean };

/** Every chore action's answer for one person and Home, for the interface. Never authoritative. */
export function chorePermissions(
  chore: ChoreFacts,
  membership: HomeMembershipFacts | null,
): ChorePermissionProjection {
  const can = (action: ChoreAction) => decideChoreAction(chore, membership, action).allowed;
  return {
    "chore.view": can("chore.view"),
    "chore.complete": can("chore.complete"),
    "chore.tickStep": can("chore.tickStep"),
    "chore.skip": can("chore.skip"),
    "chore.reopen": can("chore.reopen"),
    "chore.edit": can("chore.edit"),
    "chore.pause": can("chore.pause"),
    "chore.delete": can("chore.delete"),
    "chore.manageCategories": can("chore.manageCategories"),
    "chore.manageTemplates": can("chore.manageTemplates"),
    "chore.bulk": can("chore.bulk"),
    "chore.correct": can("chore.correct"),
    "chore.review": can("chore.review"),
    "chore.claim": can("chore.claim"),
    "chore.release": can("chore.release"),
    "chore.requestReassignment": can("chore.requestReassignment"),
    "chore.propose": can("chore.propose"),
    "chore.respondVolunteer": can("chore.respondVolunteer"),
    "chore.remind": can("chore.remind"),
    "chore.setClaimPolicy": can("chore.setClaimPolicy"),
    "chore.configure": can("chore.configure"),
    "chore.reviewProposal": can("chore.reviewProposal"),
    "chore.requestVolunteer": can("chore.requestVolunteer"),
    "chore.correctVolunteer": can("chore.correctVolunteer"),
    "chore.handoverForOthers": can("chore.handoverForOthers"),
    "chore.move": can("chore.move"),
    "chore.summary": can("chore.summary"),
  };
}
