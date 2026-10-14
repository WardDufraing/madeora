import { z } from "zod";

import {
  invitationKinds,
  type CreateInvitationInput,
  type DecisionInput,
  type InvitationKind,
} from "./schema";
import {
  deliveryStatuses,
  previewOutcomes,
  type DeliveryStatus,
  type PreviewOutcome,
} from "./types";

/**
 * The HTTP contract of the invitation endpoints (versioned, so later mobile clients can use them
 * too), and the browser's callers for them. Every endpoint is a cookie-authenticated JSON POST
 * with the same CSRF, content-type and size checks as the rest of `/api/v1`.
 *
 * Managers of a Home:
 * - `POST /api/v1/homes/{homeId}/invitations` → `201 CreatedInvitationResponse`
 * - `POST /api/v1/homes/{homeId}/invitations/{id}/revoke` → `200 {}`
 * - `POST /api/v1/homes/{homeId}/invitations/{id}/resend` → `200 EmailSentResponse`
 * - `POST /api/v1/homes/{homeId}/invitations/{id}/renew` → `200 EmailSentResponse`
 * - `POST /api/v1/homes/{homeId}/join-requests/{id}/decision` `{ decision }` → `200 DecisionResponse`
 *
 * Anyone signed in:
 * - `POST /api/v1/join-requests` `{ token }` → `200 JoinRequestResponse` (the outcome, whatever it is)
 * - `POST /api/v1/join-requests/{id}/withdraw` → `200 {}`
 *
 * A Home the caller does not belong to answers `404 not-found`, whether or not it exists; a Home
 * they belong to without the right answers `403 not-permitted`. No answer ever depends on whether
 * an email address has a Madeora account.
 */

export type InvitationErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "limit-reached"
  | "duplicate-email"
  | "not-active"
  | "has-request"
  | "rate-limited"
  | "already-decided"
  | "no-longer-valid"
  | "already-member"
  | "not-pending"
  | "failed";

export interface InvitationErrorResponse {
  readonly error: InvitationErrorCode;
  readonly fields?: readonly string[];
}

export interface CreatedInvitationResponse {
  readonly invitation: {
    readonly id: string;
    readonly kind: InvitationKind;
    readonly expiresAt: string;
    /** Links and codes: the address to share. Never for email invitations. */
    readonly url: string | null;
    /** Join codes: the code as people type it (`ABCDE-FGHJK`). */
    readonly code: string | null;
    /** Email invitations: whether the email went out. */
    readonly delivery: DeliveryStatus | null;
  };
}

export interface EmailSentResponse {
  readonly delivery: DeliveryStatus;
  readonly expiresAt: string;
}

export interface DecisionResponse {
  readonly outcome: "approved" | "declined";
}

export type JoinRequestOutcome = "requested" | PreviewOutcome;

export interface JoinRequestResponse {
  readonly outcome: JoinRequestOutcome;
  /** For `already_member`: where to go. */
  readonly homeId?: string;
}

export function invitationsEndpoint(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/invitations`;
}

export function invitationActionEndpoint(
  homeId: string,
  invitationId: string,
  action: "revoke" | "resend" | "renew",
): string {
  return `${invitationsEndpoint(homeId)}/${encodeURIComponent(invitationId)}/${action}`;
}

export function decisionEndpoint(homeId: string, requestId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/join-requests/${encodeURIComponent(requestId)}/decision`;
}

export const JOIN_REQUESTS_ENDPOINT = "/api/v1/join-requests";

export function withdrawEndpoint(requestId: string): string {
  return `${JOIN_REQUESTS_ENDPOINT}/${encodeURIComponent(requestId)}/withdraw`;
}

/** Why an invitation action did not happen, for the interface. */
export type InvitationFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "limitReached"
  | "duplicateEmail"
  | "notActive"
  | "hasRequest"
  | "rateLimited"
  | "alreadyDecided"
  | "noLongerValid"
  | "alreadyMember"
  | "notPending"
  | "network"
  | "failed";

export class InvitationActionError extends Error {
  constructor(readonly failure: InvitationFailure) {
    super(`Invitation action failed: ${failure}`);
    this.name = "InvitationActionError";
  }
}

const failureByCode: Partial<Record<InvitationErrorCode, InvitationFailure>> = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  "limit-reached": "limitReached",
  "duplicate-email": "duplicateEmail",
  "not-active": "notActive",
  "has-request": "hasRequest",
  "rate-limited": "rateLimited",
  "already-decided": "alreadyDecided",
  "no-longer-valid": "noLongerValid",
  "already-member": "alreadyMember",
  "not-pending": "notPending",
};

async function post(url: string, body: unknown): Promise<unknown> {
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
    throw new InvitationActionError("network");
  }
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const code =
      typeof json === "object" && json !== null && "error" in json ? json.error : undefined;
    const failure =
      typeof code === "string" ? failureByCode[code as InvitationErrorCode] : undefined;
    throw new InvitationActionError(failure ?? (response.status === 401 ? "signedOut" : "failed"));
  }
  return json;
}

// The answers are checked before use, so a changed server never yields half-understood data.
const createdSchema = z.object({
  invitation: z.object({
    id: z.string(),
    kind: z.enum(invitationKinds),
    expiresAt: z.string(),
    url: z.string().nullable(),
    code: z.string().nullable(),
    delivery: z.enum(deliveryStatuses).nullable(),
  }),
});
const emailSentSchema = z.object({ delivery: z.enum(deliveryStatuses), expiresAt: z.string() });
const decisionResponseSchema = z.object({ outcome: z.enum(["approved", "declined"]) });
const joinRequestResponseSchema = z.object({
  outcome: z.enum(["requested", ...previewOutcomes]),
  homeId: z.string().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new InvitationActionError("failed");
  return parsed.data;
}

export async function createInvitation(
  homeId: string,
  input: CreateInvitationInput,
): Promise<CreatedInvitationResponse["invitation"]> {
  return parse(createdSchema, await post(invitationsEndpoint(homeId), input)).invitation;
}

export async function invitationAction(
  homeId: string,
  invitationId: string,
  action: "revoke" | "resend" | "renew",
): Promise<EmailSentResponse | null> {
  const body = await post(invitationActionEndpoint(homeId, invitationId, action), {});
  return action === "revoke" ? null : parse(emailSentSchema, body);
}

export async function decideJoinRequest(
  homeId: string,
  requestId: string,
  input: DecisionInput,
): Promise<DecisionResponse> {
  return parse(decisionResponseSchema, await post(decisionEndpoint(homeId, requestId), input));
}

export async function requestToJoin(token: string): Promise<JoinRequestResponse> {
  const body = parse(joinRequestResponseSchema, await post(JOIN_REQUESTS_ENDPOINT, { token }));
  return body.homeId === undefined
    ? { outcome: body.outcome }
    : { outcome: body.outcome, homeId: body.homeId };
}

export async function withdrawJoinRequest(requestId: string): Promise<void> {
  await post(withdrawEndpoint(requestId), {});
}
