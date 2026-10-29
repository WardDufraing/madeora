/**
 * Which email and which link a notification kind gets (S14). Kept apart from the job so it is easy
 * to test for every kind. The owner's two recovery emails keep their S12b templates; the rest use
 * the generic notification email.
 */
import { notificationPath } from "@madeora/domain/notifications";
import {
  notificationKinds,
  renderNotificationEmail,
  renderOwnershipRecoveryEmail,
  type EmailLocale,
  type NotificationEmailKind,
  type RenderedEmail,
} from "@madeora/email";
import { z } from "zod";

import { PermanentJobError } from "../errors.ts";

export interface NotificationEmailInput {
  readonly kind: string;
  readonly locale: EmailLocale;
  readonly homeId: string | null;
  readonly homeName: string | null;
  readonly homeTimeZone: string | null;
  readonly params: Readonly<Record<string, unknown>>;
  /** The web app's address, no trailing path needed. */
  readonly appUrl: string;
}

const paramsSchema = z.object({
  objectionEndsAt: z.iso.datetime().optional(),
  decision: z
    .enum([
      "approved",
      "declined",
      "rejected",
      "accepted",
      "awaiting_manager",
      "confirmed",
      "refused",
    ])
    .optional(),
  reason: z.enum(["auto", "manager"]).optional(),
  occurrenceId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  dueDate: z.iso.date().nullable().optional(),
  resumesOn: z.iso.date().nullable().optional(),
  automatic: z.boolean().nullable().optional(),
  reminder: z.enum(["lead", "overdue"]).optional(),
});

/** The template for a kind whose wording depends on a parameter (the decision, the reason). */
function emailKind(kind: string, inHome: boolean, params: z.infer<typeof paramsSchema>): string {
  if (kind === "join_request.decided" && params.decision) return `${kind}.${params.decision}`;
  if (kind === "task.reminder") {
    return `${kind}.${inHome ? "home" : "personal"}${params.dueDate ? "_due" : ""}`;
  }
  if (kind === "chore.claim_released" && params.reason) return `${kind}.${params.reason}`;
  if (kind === "habit.reminder") return `${kind}.${inHome ? "home" : "personal"}`;
  if (kind === "habit.paused") return `${kind}.${params.resumesOn ? "dated" : "open"}`;
  if (kind === "habit.resumed") return `${kind}.${params.automatic ? "ended" : "manual"}`;
  if (kind === "goal.reminder") {
    return `${kind}.${inHome ? "home" : "personal"}_${params.reminder === "overdue" ? "overdue" : "lead"}`;
  }
  if (
    (kind === "chore.reassignment_answered" ||
      kind === "chore.reassignment_decided" ||
      kind === "chore.proposal_decided") &&
    params.decision
  ) {
    return `${kind}.${params.decision}`;
  }
  return kind;
}

function isEmailKind(kind: string): kind is NotificationEmailKind {
  return (notificationKinds as readonly string[]).includes(kind);
}

/**
 * Renders the email for a notification, or throws `PermanentJobError("no_email_template")` when its
 * kind has none (a kind that is never emailed, or one added without a template).
 */
export async function buildNotificationEmail(
  input: NotificationEmailInput,
): Promise<RenderedEmail> {
  const params = paramsSchema.safeParse(input.params);
  if (!params.success) throw new PermanentJobError("invalid_params");
  const url = new URL(
    notificationPath(input.kind, input.homeId, input.params),
    input.appUrl,
  ).toString();
  const timeZone = input.homeTimeZone ?? "UTC";
  // A notice without a Home (a case that ended after the person left it) still reads as a sentence.
  const homeName = input.homeName ?? (input.locale === "nl" ? "een Home" : "a Home");
  const endsAt = params.data.objectionEndsAt ? new Date(params.data.objectionEndsAt) : null;

  if (input.kind === "recovery.owner_review_started" || input.kind === "recovery.owner_approved") {
    const approved = input.kind === "recovery.owner_approved";
    if (approved && !endsAt) throw new PermanentJobError("invalid_params");
    return renderOwnershipRecoveryEmail({
      kind: approved ? "approved" : "review_started",
      locale: input.locale,
      homeName,
      url,
      objectionEndsAt: approved ? endsAt : null,
      timeZone,
    });
  }

  const kind = emailKind(input.kind, input.homeId !== null, params.data);
  if (!isEmailKind(kind)) throw new PermanentJobError("no_email_template");
  if (kind === "recovery.claimant_approved" && !endsAt)
    throw new PermanentJobError("invalid_params");
  return renderNotificationEmail({
    kind,
    locale: input.locale,
    homeName,
    url,
    date: endsAt,
    day: params.data.dueDate ?? params.data.resumesOn ?? null,
    timeZone,
  });
}
