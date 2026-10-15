import { getPublicEnv } from "@madeora/config/env/public";
import type { OwnershipRecoveryEmailKind } from "@madeora/email";
import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { sendOwnershipRecoveryEmail } from "@/email/send";
import type { EmailDelivery, StaffDecisionResponse } from "@/recovery/api";
import { staffDecisionSchema } from "@/recovery/schema";
import {
  databaseFailure,
  failure,
  getStaffCase,
  json,
  outcomeFailure,
  readRecoveryMutation,
} from "@/recovery/server";

const MAX_BODY_BYTES = 16 * 1024;

interface DecisionRouteContext {
  readonly params: Promise<{ readonly recoveryId: string }>;
}

/**
 * Madeora staff act on a recovery case: start the review, approve, pause, resume or reject (S12b;
 * architecture.md §43). The database checks the caller is staff and signed in within 15 minutes,
 * re-checks the case under the Home's lock and audits the decision with the staff account.
 *
 * When the review starts, and whenever the case (re)enters its objection period, the Owner is
 * emailed at their confirmed address. That happens here, not at submission, so the session of the
 * member who asked never handles the Owner's address.
 */
export async function POST(request: Request, { params }: DecisionRouteContext): Promise<Response> {
  const input = await readRecoveryMutation(request, staffDecisionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { recoveryId } = await params;
  const parsedId = z.uuid().safeParse(recoveryId);
  if (!parsedId.success) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("staff_decide_ownership_recovery", {
    p_recovery_id: parsedId.data,
    p_action: input.data.action,
    p_notes: input.data.notes,
    ...(input.data.formerOwnerOutcome
      ? { p_former_owner_outcome: input.data.formerOwnerOutcome }
      : {}),
  });
  if (error) return databaseFailure("recovery.staff_decision_failed", error, { staff: true });
  if (data !== "ok") return outcomeFailure(data);

  const response: StaffDecisionResponse = {
    ownerEmail: await emailOwner(parsedId.data, input.data.action),
  };
  return json(200, response);
}

async function emailOwner(recoveryId: string, action: string): Promise<EmailDelivery | null> {
  if (action !== "start_review" && action !== "approve" && action !== "resume") return null;
  const read = await getStaffCase(recoveryId);
  if (read.status !== "ok" || !read.value) return "failed";
  const recovery = read.value;
  let kind: OwnershipRecoveryEmailKind;
  if (action === "start_review" && recovery.state === "in_review") kind = "review_started";
  else if (recovery.state === "approved" && recovery.objectionEndsAt) kind = "approved";
  else return null;
  if (!recovery.ownerIsOwner || !recovery.ownerEmail) return "failed";

  const url = new URL(
    `/homes/${encodeURIComponent(recovery.homeId)}`,
    getPublicEnv().NEXT_PUBLIC_APP_URL,
  ).toString();
  return sendOwnershipRecoveryEmail(
    recovery.ownerEmail,
    {
      kind,
      locale: recovery.ownerLocale ?? "en",
      homeName: recovery.homeName,
      url,
      objectionEndsAt: kind === "approved" ? new Date(recovery.objectionEndsAt ?? "") : null,
      timeZone: recovery.homeTimeZone,
    },
    // One email per review start and per objection period, however often staff retry.
    kind === "approved"
      ? `ownership-recovery-${recoveryId}-approved-${recovery.objectionEndsAt ?? ""}`
      : `ownership-recovery-${recoveryId}-review`,
  );
}
