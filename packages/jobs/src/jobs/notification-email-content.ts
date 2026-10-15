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
  decision: z.enum(["approved", "declined"]).optional(),
});

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
  const url = new URL(notificationPath(input.kind, input.homeId), input.appUrl).toString();
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

  const kind =
    input.kind === "join_request.decided" && params.data.decision
      ? `join_request.decided.${params.data.decision}`
      : input.kind;
  if (!isEmailKind(kind)) throw new PermanentJobError("no_email_template");
  if (kind === "recovery.claimant_approved" && !endsAt)
    throw new PermanentJobError("invalid_params");
  return renderNotificationEmail({
    kind,
    locale: input.locale,
    homeName,
    url,
    date: endsAt,
    timeZone,
  });
}
