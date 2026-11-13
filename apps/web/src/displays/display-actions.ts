import "server-only";

import { householdClientKey, householdService } from "@/child-sign-in/service";
import { verifyChildSecret } from "@/child-sign-in/secret-hash";

/**
 * Actions on a paired display (S44; spec "Confirmed Household Display member-only actions"): a
 * member completes a chore with the S42 PIN rules, and a manager locks the display with their own
 * PIN. The caller has already confirmed which display is asking from its own session
 * (`display_me`); the database functions run as the service role, because they hand this server a
 * PIN hash to compare, which a display's token must never see. They check again that the display
 * is active, unlocked and offers actions, and that the member is eligible now. PINs are compared
 * here and never logged; events carry a name and a database code only.
 */

export type DisplayChoreResult =
  | { readonly kind: "completed" | "submitted"; readonly actionId: string }
  | { readonly kind: "locked"; readonly until: string | null }
  | {
      readonly kind:
        | "already-done"
        | "steps-incomplete"
        | "invalid-pin"
        | "pin-required"
        | "pin-not-set"
        | "rate-limited"
        | "not-eligible"
        | "display-locked"
        | "actions-off"
        | "not-paired"
        | "unavailable";
    };

function log(event: string, code?: string): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

function fromOutcome(outcome: string | undefined, actionId: string | null): DisplayChoreResult {
  switch (outcome) {
    case "completed":
    case "submitted":
      return actionId ? { kind: outcome, actionId } : { kind: "unavailable" };
    case "already_completed":
    case "already_submitted":
    case "already_skipped":
    case "occurrence_closed":
    case "not_found":
      return { kind: "already-done" };
    case "steps_incomplete":
      return { kind: "steps-incomplete" };
    case "not_eligible":
    case "invalid_contributor":
      return { kind: "not-eligible" };
    case "display_locked":
      return { kind: "display-locked" };
    case "actions_off":
      return { kind: "actions-off" };
    case "display_not_active":
      return { kind: "not-paired" };
    default:
      return { kind: "unavailable" };
  }
}

/** Completes a chore on the display for a member, with their PIN when one is given. */
export async function completeChoreOnDisplay(
  displayId: string,
  occurrenceId: string,
  membershipId: string,
  pin: string | null,
): Promise<DisplayChoreResult> {
  const client = householdService();
  const key = await householdClientKey();
  if (!client || !key) return { kind: "unavailable" };
  const attempt = await client.rpc("display_chore_attempt", {
    p_display_id: displayId,
    p_occurrence_id: occurrenceId,
    p_membership_id: membershipId,
    p_pin: pin !== null,
    p_client_key: key,
  });
  if (attempt.error) {
    log("display_chores.attempt_failed", attempt.error.code);
    return { kind: "unavailable" };
  }
  const row = attempt.data[0];
  switch (row?.outcome) {
    case "pin_required":
      return { kind: "pin-required" };
    case "pin_not_set":
      return { kind: "pin-not-set" };
    case "rate_limited":
      return { kind: "rate-limited" };
    case "locked":
      return {
        kind: "locked",
        until: row.locked_until && row.locked_until !== "infinity" ? row.locked_until : null,
      };
    case "check": {
      if (pin === null || !row.check_id || !row.pin_hash) return { kind: "unavailable" };
      if (!(await verifyChildSecret(pin, row.pin_hash))) return { kind: "invalid-pin" };
      const verified = await client.rpc("display_chore_verified", {
        p_display_id: displayId,
        p_check_id: row.check_id,
      });
      if (verified.error) {
        log("display_chores.verify_failed", verified.error.code);
        return { kind: "unavailable" };
      }
      const done = verified.data[0];
      return fromOutcome(done?.outcome, done?.action_id ?? null);
    }
    default:
      return fromOutcome(row?.outcome, row?.action_id ?? null);
  }
}

/** Undoes a completion this display made in the last two minutes. */
export async function undoChoreOnDisplay(
  displayId: string,
  actionId: string,
): Promise<"undone" | "expired" | "invalid" | "unavailable"> {
  const client = householdService();
  if (!client) return "unavailable";
  const { data, error } = await client.rpc("display_chore_undo", {
    p_display_id: displayId,
    p_action_id: actionId,
  });
  if (error) {
    log("display_chores.undo_failed", error.code);
    return "unavailable";
  }
  return data === "undone" || data === "expired" ? data : "invalid";
}

export type DisplayLockResult =
  | { readonly kind: "locked-now" }
  | { readonly kind: "pin-locked"; readonly until: string | null }
  | {
      readonly kind:
        | "already-locked"
        | "invalid-pin"
        | "pin-not-set"
        | "not-permitted"
        | "rate-limited"
        | "not-paired"
        | "unavailable";
    };

/**
 * Locks the display on the display itself: a manager of its Home confirms with their own PIN.
 * There is no unlock here (spec: privacy-mode unlock needs a manager's own session).
 */
export async function lockOnDisplay(
  displayId: string,
  membershipId: string,
  pin: string,
): Promise<DisplayLockResult> {
  const client = householdService();
  const key = await householdClientKey();
  if (!client || !key) return { kind: "unavailable" };
  const attempt = await client.rpc("display_lock_attempt", {
    p_display_id: displayId,
    p_membership_id: membershipId,
    p_client_key: key,
  });
  if (attempt.error) {
    log("display_lock.attempt_failed", attempt.error.code);
    return { kind: "unavailable" };
  }
  const row = attempt.data[0];
  switch (row?.outcome) {
    case "unchanged":
      return { kind: "already-locked" };
    case "not_permitted":
      return { kind: "not-permitted" };
    case "pin_not_set":
      return { kind: "pin-not-set" };
    case "rate_limited":
      return { kind: "rate-limited" };
    case "display_not_active":
      return { kind: "not-paired" };
    case "locked":
      return {
        kind: "pin-locked",
        until: row.locked_until && row.locked_until !== "infinity" ? row.locked_until : null,
      };
    case "check": {
      if (!row.check_id || !row.pin_hash) return { kind: "unavailable" };
      if (!(await verifyChildSecret(pin, row.pin_hash))) return { kind: "invalid-pin" };
      const verified = await client.rpc("display_lock_verified", {
        p_display_id: displayId,
        p_check_id: row.check_id,
      });
      if (verified.error) {
        log("display_lock.verify_failed", verified.error.code);
        return { kind: "unavailable" };
      }
      if (verified.data === "saved" || verified.data === "unchanged") return { kind: "locked-now" };
      if (verified.data === "not_permitted") return { kind: "not-permitted" };
      return { kind: "unavailable" };
    }
    default:
      return { kind: "unavailable" };
  }
}
