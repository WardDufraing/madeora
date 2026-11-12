import "server-only";

import { z } from "zod";

import { householdClientKey, householdService } from "./service";
import { verifyChildSecret } from "./secret-hash";

/**
 * Chores on an approved household device (S42 part 2; spec "Confirmed shared-device chore
 * attribution and optional PIN verification"). The device is not signed in as anyone: the member
 * picks a chore, says who did it and, when the Home requires it or they choose to, types their
 * PIN. The database completes the chore as that member for one call only. The PIN is compared
 * here with the scrypt hash and is never logged; events carry a name and a database code only.
 */

const boardSchema = z.object({
  require_pin: z.boolean(),
  members: z.array(
    z.object({
      membership_id: z.uuid(),
      name: z.string().nullable(),
      accent_color: z.string().nullable(),
      is_child: z.boolean(),
      has_pin: z.boolean(),
      requires_pin: z.boolean(),
    }),
  ),
  chores: z.array(
    z.object({
      occurrence_id: z.uuid(),
      title: z.string(),
      due_date: z.string(),
      overdue: z.boolean(),
      assignee_ids: z.array(z.uuid()),
      mandatory_open: z.number().int(),
      requires_approval: z.boolean(),
      requires_pin: z.boolean(),
    }),
  ),
});

export interface DeviceMember {
  readonly membershipId: string;
  readonly name: string | null;
  readonly accentColor: string | null;
  readonly isChild: boolean;
  readonly hasPin: boolean;
  /** A Home manager requires this member's PIN for every chore on household devices. */
  readonly requiresPin: boolean;
}

export interface DeviceChore {
  readonly occurrenceId: string;
  readonly title: string;
  readonly dueDate: string;
  readonly overdue: boolean;
  readonly assigneeIds: readonly string[];
  readonly mandatoryOpen: number;
  readonly requiresApproval: boolean;
  /** A Home manager requires a PIN for this chore on household devices. */
  readonly requiresPin: boolean;
}

export interface DeviceBoard {
  readonly requirePin: boolean;
  readonly members: readonly DeviceMember[];
  readonly chores: readonly DeviceChore[];
}

function log(event: string, code?: string): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

/** The device's chore screen; `null` for an unknown or revoked device, `undefined` when unreadable. */
export async function getDeviceChoreBoard(
  deviceHash: string,
): Promise<DeviceBoard | null | undefined> {
  const client = householdService();
  if (!client) return undefined;
  const { data, error } = await client.rpc("shared_device_board", { p_device_hash: deviceHash });
  if (error) {
    log("device_chores.board_failed", error.code);
    return undefined;
  }
  if (data === null) return null;
  const parsed = boardSchema.safeParse(data);
  if (!parsed.success) {
    log("device_chores.board_shape");
    return undefined;
  }
  return {
    requirePin: parsed.data.require_pin,
    members: parsed.data.members.map((m) => ({
      membershipId: m.membership_id,
      name: m.name,
      accentColor: m.accent_color,
      isChild: m.is_child,
      hasPin: m.has_pin,
      requiresPin: m.requires_pin,
    })),
    chores: parsed.data.chores.map((c) => ({
      occurrenceId: c.occurrence_id,
      title: c.title,
      dueDate: c.due_date,
      overdue: c.overdue,
      assigneeIds: c.assignee_ids,
      mandatoryOpen: c.mandatory_open,
      requiresApproval: c.requires_approval,
      requiresPin: c.requires_pin,
    })),
  };
}

export type DeviceChoreResult =
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
        | "device-not-approved"
        | "unavailable";
    };

function fromCompletion(outcome: string | undefined, actionId: string | null): DeviceChoreResult {
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
    default:
      return { kind: "unavailable" };
  }
}

/** Completes a chore on the device for a member, with their PIN when one is given. */
export async function completeChoreOnDevice(
  deviceHash: string,
  occurrenceId: string,
  membershipId: string,
  pin: string | null,
): Promise<DeviceChoreResult> {
  const client = householdService();
  const key = await householdClientKey();
  if (!client || !key) return { kind: "unavailable" };
  const attempt = await client.rpc("shared_device_attempt", {
    p_device_hash: deviceHash,
    p_occurrence_id: occurrenceId,
    p_membership_id: membershipId,
    p_pin: pin !== null,
    p_client_key: key,
  });
  if (attempt.error) {
    log("device_chores.attempt_failed", attempt.error.code);
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
    case "device_not_approved":
      return { kind: "device-not-approved" };
    case "locked":
      return {
        kind: "locked",
        until: row.locked_until && row.locked_until !== "infinity" ? row.locked_until : null,
      };
    case "check": {
      if (pin === null || !row.check_id || !row.pin_hash) return { kind: "unavailable" };
      if (!(await verifyChildSecret(pin, row.pin_hash))) return { kind: "invalid-pin" };
      const verified = await client.rpc("shared_device_verified", {
        p_device_hash: deviceHash,
        p_check_id: row.check_id,
      });
      if (verified.error) {
        log("device_chores.verify_failed", verified.error.code);
        return { kind: "unavailable" };
      }
      const done = verified.data[0];
      return fromCompletion(done?.outcome, done?.action_id ?? null);
    }
    default:
      return fromCompletion(row?.outcome, row?.action_id ?? null);
  }
}

/** Undoes a completion this device made in the last two minutes. */
export async function undoChoreOnDevice(
  deviceHash: string,
  actionId: string,
): Promise<"undone" | "expired" | "invalid" | "unavailable"> {
  const client = householdService();
  if (!client) return "unavailable";
  const { data, error } = await client.rpc("shared_device_undo", {
    p_device_hash: deviceHash,
    p_action_id: actionId,
  });
  if (error) {
    log("device_chores.undo_failed", error.code);
    return "unavailable";
  }
  return data === "undone" || data === "expired" ? data : "invalid";
}
