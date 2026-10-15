import type { DateTimeFormats } from "@/invitations/format";
import { formatDateTime } from "@/invitations/format";
import type { RecoveryState } from "@/recovery/schema";
import type { RecoveryStatusView } from "@/recovery/server";

export const stateKey = {
  submitted: "stateSubmitted",
  in_review: "stateInReview",
  approved: "stateApproved",
  ready: "stateReady",
  paused: "statePaused",
  completed: "stateCompleted",
  rejected: "stateRejected",
  withdrawn: "stateWithdrawn",
  cancelled: "stateCancelled",
  owner_returned: "stateOwnerReturned",
  invalid: "stateInvalid",
} as const satisfies Record<RecoveryState, string>;

/** The `Recovery` translator, narrowed to the state sentences. */
type Translate = (
  key: (typeof stateKey)[RecoveryState],
  values: { home: string; date: string },
) => string;

/** Whether other members should see this case as an open review. */
export function isOpenForOthers(state: RecoveryState): boolean {
  return (
    state === "submitted" ||
    state === "in_review" ||
    state === "approved" ||
    state === "ready" ||
    state === "paused"
  );
}

/** The person who asked: where their request stands, in one sentence. */
export function claimantStateText(
  t: Translate,
  recovery: Pick<RecoveryStatusView, "state" | "objectionEndsAt">,
  homeName: string,
  formats: DateTimeFormats,
): string {
  const date = recovery.objectionEndsAt ? formatDateTime(recovery.objectionEndsAt, formats) : "";
  return t(stateKey[recovery.state], { home: homeName, date });
}
