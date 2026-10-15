import type { RecoveryState, StaffAction } from "@/recovery/schema";

/** The `Recovery` keys naming each state for staff. */
export const staffStateKey = {
  submitted: "staffStateSubmitted",
  in_review: "staffStateInReview",
  approved: "staffStateApproved",
  ready: "staffStateReady",
  paused: "staffStatePaused",
  completed: "staffStateCompleted",
  rejected: "staffStateRejected",
  withdrawn: "staffStateWithdrawn",
  cancelled: "staffStateCancelled",
  owner_returned: "staffStateOwnerReturned",
  invalid: "staffStateInvalid",
} as const satisfies Record<RecoveryState, string>;

/** What staff may do in each state; mirrors `public.staff_decide_ownership_recovery`. */
export function staffActionsFor(state: RecoveryState): readonly StaffAction[] {
  switch (state) {
    case "submitted":
      return ["start_review", "pause", "reject"];
    case "in_review":
      return ["approve", "pause", "reject"];
    case "approved":
    case "ready":
      return ["pause", "reject"];
    case "paused":
      return ["resume", "reject"];
    default:
      return [];
  }
}
