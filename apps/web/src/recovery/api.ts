import { z } from "zod";

import { homeEndpoint } from "@/homes/api";

import {
  claimantActions,
  type ClaimantAction,
  type RecoveryAppealInput,
  type RecoveryObjectionInput,
  type RecoveryRequestInput,
  type StaffAppealCloseInput,
  type StaffDecisionInput,
} from "./schema";

/**
 * The HTTP contract of verified Home ownership recovery (S12b; versioned, so later mobile clients
 * can use it too) and the browser's callers for it. Every endpoint is a cookie-authenticated JSON
 * request with the same CSRF, content-type and size checks as the rest of `/api/v1`.
 *
 * Members of the Home:
 * - `POST /api/v1/homes/{homeId}/ownership-recoveries` `{ statement, requestId }`
 *   → `201 { recovery: { id } }`; `403 not-permitted` for the Owner or a member who joined less
 *   than 30 days ago; `409 already-open`.
 * - `POST /api/v1/homes/{homeId}/ownership-recoveries/{recoveryId}/{withdraw|accept}` `{}`
 *   → `200 {}`; accept: `409 not-ready`, `409 owner-returned`, `409 no-longer-valid`.
 * - `POST /api/v1/homes/{homeId}/ownership-recoveries/cancel` `{}` (the Owner) → `200 { cancelled }`.
 * - `POST /api/v1/homes/{homeId}/ownership-recoveries/objections` `{ reason }` → `200 {}`;
 *   `409 nothing-open`.
 *
 * A former Owner:
 * - `POST /api/v1/me/ownership-recoveries/{recoveryId}/appeal` `{ reason }` → `200 {}`;
 *   `409 already-open`.
 *
 * Madeora staff (architecture.md §43):
 * - `POST /api/v1/staff/ownership-recoveries/{recoveryId}/decision`
 *   `{ action, notes, formerOwnerOutcome }` → `200 { ownerEmail }` where `ownerEmail` says
 *   whether the Owner was emailed (`sent`, `failed`, `not_configured`, or `null` when the action
 *   sends none); `409 not-allowed`, `409 owner-returned`, `409 no-longer-valid`;
 *   `401 reauthenticate` when the staff member's last sign-in is older than 15 minutes.
 * - `POST /api/v1/staff/recovery-appeals/{appealId}/close` `{ notes }` → `200 {}`.
 *
 * A Home the caller does not belong to answers `404 not-found`; non-staff calling a staff endpoint
 * also gets `404 not-found`, so the staff endpoints do not reveal themselves.
 */

export function recoveriesEndpoint(homeId: string): string {
  return `${homeEndpoint(homeId)}/ownership-recoveries`;
}

export function recoveryActionEndpoint(
  homeId: string,
  recoveryId: string,
  action: ClaimantAction,
): string {
  return `${recoveriesEndpoint(homeId)}/${encodeURIComponent(recoveryId)}/${action}`;
}

export function appealEndpoint(recoveryId: string): string {
  return `/api/v1/me/ownership-recoveries/${encodeURIComponent(recoveryId)}/appeal`;
}

export function staffDecisionEndpoint(recoveryId: string): string {
  return `/api/v1/staff/ownership-recoveries/${encodeURIComponent(recoveryId)}/decision`;
}

export function staffAppealCloseEndpoint(appealId: string): string {
  return `/api/v1/staff/recovery-appeals/${encodeURIComponent(appealId)}/close`;
}

export type RecoveryErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "reauthenticate"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "already-open"
  | "already-decided"
  | "not-ready"
  | "owner-returned"
  | "no-longer-valid"
  | "nothing-open"
  | "not-allowed"
  | "failed";

export interface RecoveryErrorResponse {
  readonly error: RecoveryErrorCode;
  readonly fields?: readonly string[];
}

export interface RequestRecoveryResponse {
  readonly recovery: { readonly id: string };
}

export interface CancelRecoveriesResponse {
  readonly cancelled: number;
}

export type EmailDelivery = "sent" | "failed" | "not_configured";

export interface StaffDecisionResponse {
  readonly ownerEmail: EmailDelivery | null;
}

/** Why a recovery action did not happen, for the interface. */
export type RecoveryFailure =
  | "signedOut"
  | "reauthenticate"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "alreadyOpen"
  | "alreadyDecided"
  | "notReady"
  | "ownerReturned"
  | "noLongerValid"
  | "nothingOpen"
  | "notAllowed"
  | "network"
  | "failed";

export class RecoveryActionError extends Error {
  constructor(readonly failure: RecoveryFailure) {
    super(`Recovery action failed: ${failure}`);
    this.name = "RecoveryActionError";
  }
}

const failureByCode: Partial<Record<RecoveryErrorCode, RecoveryFailure>> = {
  unauthenticated: "signedOut",
  reauthenticate: "reauthenticate",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  "already-open": "alreadyOpen",
  "already-decided": "alreadyDecided",
  "not-ready": "notReady",
  "owner-returned": "ownerReturned",
  "no-longer-valid": "noLongerValid",
  "nothing-open": "nothingOpen",
  "not-allowed": "notAllowed",
};

async function send(url: string, body: unknown): Promise<unknown> {
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
    throw new RecoveryActionError("network");
  }
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const code =
      typeof json === "object" && json !== null && "error" in json ? json.error : undefined;
    const failure = typeof code === "string" ? failureByCode[code as RecoveryErrorCode] : undefined;
    throw new RecoveryActionError(failure ?? (response.status === 401 ? "signedOut" : "failed"));
  }
  return json;
}

// The answers are checked before use, so a changed server never yields half-understood data.
const requestResponseSchema = z.object({ recovery: z.object({ id: z.string() }) });
const cancelResponseSchema = z.object({ cancelled: z.number().int().nonnegative() });
const decisionResponseSchema = z.object({
  ownerEmail: z.enum(["sent", "failed", "not_configured"]).nullable(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new RecoveryActionError("failed");
  return parsed.data;
}

export async function requestRecovery(
  homeId: string,
  input: RecoveryRequestInput,
): Promise<RequestRecoveryResponse> {
  return parse(requestResponseSchema, await send(recoveriesEndpoint(homeId), input));
}

export async function recoveryAction(
  homeId: string,
  recoveryId: string,
  action: ClaimantAction,
): Promise<void> {
  if (!(claimantActions as readonly string[]).includes(action)) {
    throw new RecoveryActionError("invalid");
  }
  await send(recoveryActionEndpoint(homeId, recoveryId, action), {});
}

export async function cancelRecoveries(homeId: string): Promise<CancelRecoveriesResponse> {
  return parse(cancelResponseSchema, await send(`${recoveriesEndpoint(homeId)}/cancel`, {}));
}

export async function objectToRecovery(
  homeId: string,
  input: RecoveryObjectionInput,
): Promise<void> {
  await send(`${recoveriesEndpoint(homeId)}/objections`, input);
}

export async function appealRecovery(
  recoveryId: string,
  input: RecoveryAppealInput,
): Promise<void> {
  await send(appealEndpoint(recoveryId), input);
}

export async function decideRecovery(
  recoveryId: string,
  input: StaffDecisionInput,
): Promise<StaffDecisionResponse> {
  return parse(decisionResponseSchema, await send(staffDecisionEndpoint(recoveryId), input));
}

export async function closeRecoveryAppeal(
  appealId: string,
  input: StaffAppealCloseInput,
): Promise<void> {
  await send(staffAppealCloseEndpoint(appealId), input);
}
