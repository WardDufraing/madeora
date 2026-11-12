import { z } from "zod";

import { childEndpoint } from "@/children/api";
import { MemberActionError, sendMemberRequest } from "@/members/manage-api";

import type { ClaimInput, StartTransitionInput } from "./schema";

/**
 * The HTTP contract of the move to an independent account (S42 part 3) and the browser's callers.
 *
 * Guardians (database decides: starting needs the primary guardian of every Home of the child;
 * either guardian may cancel):
 * - `POST /api/v1/homes/{homeId}/children/{membershipId}/transition` `{ birthDate }`
 *   → `200 { outcome: "started", claimUrl, expiresAt }` or `200 { outcome: "not_eligible",
 *   eligibleOn }`; `403 not-permitted`
 * - `POST /api/v1/homes/{homeId}/children/{membershipId}/transition/cancel` `{}`
 *   → `200 { outcome: "cancelled" | "unchanged" }`
 *
 * The young person (no session; the link's secret is the only key):
 * - `POST /api/v1/claim` `{ token, email }` → `200 {}`; `404 invalid`, `400 invalid-email`,
 *   `409 email-taken`, `429 rate-limited`, `503 unavailable`
 * - `POST /api/v1/claim/complete` `{ token }` → `200 {}`; `404 invalid`, `409 email-taken`,
 *   `503 unavailable`
 */

export function transitionEndpoint(homeId: string, membershipId: string): string {
  return `${childEndpoint(homeId, membershipId)}/transition`;
}

const startResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("started"), claimUrl: z.url(), expiresAt: z.string() }),
  z.object({ outcome: z.literal("not_eligible"), eligibleOn: z.string() }),
]);
export type StartTransitionResult = z.output<typeof startResponseSchema>;

export async function startTransition(
  homeId: string,
  membershipId: string,
  input: StartTransitionInput,
): Promise<StartTransitionResult> {
  const parsed = startResponseSchema.safeParse(
    await sendMemberRequest("POST", transitionEndpoint(homeId, membershipId), input),
  );
  if (!parsed.success) throw new MemberActionError("failed");
  return parsed.data;
}

export async function cancelTransition(homeId: string, membershipId: string): Promise<void> {
  await sendMemberRequest("POST", `${transitionEndpoint(homeId, membershipId)}/cancel`, {});
}

export const CLAIM_ENDPOINT = "/api/v1/claim";
export const CLAIM_COMPLETE_ENDPOINT = "/api/v1/claim/complete";

export type ClaimFailure =
  "invalid" | "invalidEmail" | "emailTaken" | "rateLimited" | "unavailable" | "network" | "failed";

const claimFailureByCode: Record<string, ClaimFailure> = {
  invalid: "invalid",
  "invalid-email": "invalidEmail",
  "email-taken": "emailTaken",
  "rate-limited": "rateLimited",
  unavailable: "unavailable",
};

const errorSchema = z.object({ error: z.string() });

async function post(url: string, body: unknown): Promise<ClaimFailure | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return "network";
  }
  if (response.ok) return null;
  const parsed = errorSchema.safeParse(await response.json().catch(() => ({})));
  return (parsed.success ? claimFailureByCode[parsed.data.error] : undefined) ?? "failed";
}

/** `null` when the verification email is on its way. */
export function claimAccount(input: ClaimInput): Promise<ClaimFailure | null> {
  return post(CLAIM_ENDPOINT, input);
}

/** `null` when the move is complete. */
export function completeClaim(token: string): Promise<ClaimFailure | null> {
  return post(CLAIM_COMPLETE_ENDPOINT, { token });
}
