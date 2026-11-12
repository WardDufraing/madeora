import "server-only";

import { z } from "zod";

import { householdService } from "@/child-sign-in/service";

/**
 * The young person's steps of the move to an independent account (S42 part 3). They are not
 * signed in, so the web server calls the database as service_role with the link's secret; the
 * secret is never logged.
 */

const summarySchema = z.object({
  name: z.string().nullable(),
  homes: z.array(z.string()),
  guardians: z.number().int(),
  has_username: z.boolean(),
  pin_homes: z.number().int(),
  email: z.string().nullable(),
});

export interface TransitionSummary {
  readonly name: string | null;
  readonly homes: readonly string[];
  readonly guardians: number;
  readonly hasUsername: boolean;
  readonly pinHomes: number;
  readonly email: string | null;
}

function log(event: string, code?: string): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

function toSummary(value: unknown): TransitionSummary | null {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    name: parsed.data.name,
    homes: parsed.data.homes,
    guardians: parsed.data.guardians,
    hasUsername: parsed.data.has_username,
    pinHomes: parsed.data.pin_homes,
    email: parsed.data.email,
  };
}

/** The claim screen: `null` for a wrong, used or expired link, `undefined` when unreadable. */
export async function previewClaim(token: string): Promise<TransitionSummary | null | undefined> {
  const client = householdService();
  if (!client) return undefined;
  const { data, error } = await client.rpc("child_transition_preview", { p_token: token });
  if (error) {
    log("child_transition.preview_failed", error.code);
    return undefined;
  }
  if (data === null) return null;
  return toSummary(data) ?? undefined;
}

export type ClaimResult = "sent" | "invalid" | "invalid_email" | "email_taken" | "rate_limited";

/** Emails a verification link to the address the young person gave. */
export async function claimTransition(
  token: string,
  email: string,
): Promise<ClaimResult | "unavailable"> {
  const client = householdService();
  if (!client) return "unavailable";
  const { data, error } = await client.rpc("claim_child_transition", {
    p_token: token,
    p_email: email,
  });
  if (error) {
    log("child_transition.claim_failed", error.code);
    return "unavailable";
  }
  switch (data) {
    case "sent":
    case "invalid":
    case "invalid_email":
    case "email_taken":
    case "rate_limited":
      return data;
    default:
      return "unavailable";
  }
}

export type TransitionReview =
  { readonly completed: true } | ({ readonly completed: false } & TransitionSummary);

/** The confirmation screen from the emailed link: `null` for a wrong or expired link. */
export async function reviewTransition(
  token: string,
): Promise<TransitionReview | null | undefined> {
  const client = householdService();
  if (!client) return undefined;
  const { data, error } = await client.rpc("child_transition_review", { p_email_token: token });
  if (error) {
    log("child_transition.review_failed", error.code);
    return undefined;
  }
  if (data === null) return null;
  const done = z.object({ completed: z.boolean() }).safeParse(data);
  if (!done.success) return undefined;
  if (done.data.completed) return { completed: true };
  const summary = toSummary(data);
  return summary ? { completed: false, ...summary } : undefined;
}

/** Completes the move. A retry of a completed link answers `completed` again. */
export async function completeTransition(
  token: string,
): Promise<"completed" | "invalid" | "email_taken" | "unavailable"> {
  const client = householdService();
  if (!client) return "unavailable";
  const { data, error } = await client.rpc("complete_child_transition", { p_email_token: token });
  if (error) {
    log("child_transition.complete_failed", error.code);
    return "unavailable";
  }
  return data === "completed" || data === "invalid" || data === "email_taken"
    ? data
    : "unavailable";
}
