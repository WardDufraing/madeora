import { delegableCapabilities, type DelegableCapability } from "@madeora/domain/permissions";
import { z } from "zod";

import { homeEndpoint } from "@/homes/api";

import {
  assignableRoles,
  type CapabilitiesInput,
  type RemovalInput,
  type RoleChangeInput,
  type StartTransferInput,
  type TransferAction,
  transferAnswers,
  type TransferAnswer,
} from "./manage-schema";

/**
 * The HTTP contract of the member-management endpoints (S12; versioned, so later mobile clients
 * can use them too) and the browser's callers for them. Every endpoint is a cookie-authenticated
 * JSON request with the same CSRF, content-type and size checks as the rest of `/api/v1`.
 *
 * - `PATCH /api/v1/homes/{homeId}/members/{membershipId}` `{ role, expectedRole }` → `200 { role }`
 * - `PUT /api/v1/homes/{homeId}/members/{membershipId}/capabilities` `{ capabilities }`
 *   → `200 { capabilities }`
 * - `POST /api/v1/homes/{homeId}/members/{membershipId}/remove` `{ expectedRole }` → `200 {}`
 * - `POST /api/v1/homes/{homeId}/leave` `{}` → `200 {}`
 * - `POST /api/v1/homes/{homeId}/ownership-transfers` `{ membershipId, requestId }`
 *   → `201 { transfer: { id } }`
 * - `POST /api/v1/homes/{homeId}/ownership-transfers/{transferId}/{accept|decline|cancel}` `{}`
 *   → `200 { outcome }`
 *
 * A Home the caller does not belong to, and a member who is not (or no longer) in it, answer
 * `404 not-found`; an action the caller's role or grants do not allow answers `403 not-permitted`;
 * a confirmation made from an outdated view (the target's role changed) answers `409 stale`.
 */

export function membersEndpoint(homeId: string, membershipId: string): string {
  return `${homeEndpoint(homeId)}/members/${encodeURIComponent(membershipId)}`;
}

export function leaveEndpoint(homeId: string): string {
  return `${homeEndpoint(homeId)}/leave`;
}

export function transfersEndpoint(homeId: string): string {
  return `${homeEndpoint(homeId)}/ownership-transfers`;
}

export function transferActionEndpoint(
  homeId: string,
  transferId: string,
  action: TransferAction,
): string {
  return `${transfersEndpoint(homeId)}/${encodeURIComponent(transferId)}/${action}`;
}

export type MemberErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "stale"
  | "pending-exists"
  | "invalid-target"
  | "owner-must-transfer"
  | "already-decided"
  | "expired"
  | "no-longer-valid"
  | "failed";

export interface MemberErrorResponse {
  readonly error: MemberErrorCode;
  readonly fields?: readonly string[];
}

export interface RoleChangeResponse {
  readonly role: (typeof assignableRoles)[number];
}

export interface CapabilitiesResponse {
  readonly capabilities: readonly DelegableCapability[];
}

export interface StartTransferResponse {
  readonly transfer: { readonly id: string };
}

export interface TransferActionResponse {
  readonly outcome: TransferAnswer;
}

/** Why a member action did not happen, for the interface. */
export type MemberFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "stale"
  | "pendingExists"
  | "invalidTarget"
  | "ownerMustTransfer"
  | "alreadyDecided"
  | "expired"
  | "noLongerValid"
  | "network"
  | "failed";

export class MemberActionError extends Error {
  constructor(readonly failure: MemberFailure) {
    super(`Member action failed: ${failure}`);
    this.name = "MemberActionError";
  }
}

const failureByCode: Partial<Record<MemberErrorCode, MemberFailure>> = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  stale: "stale",
  "pending-exists": "pendingExists",
  "invalid-target": "invalidTarget",
  "owner-must-transfer": "ownerMustTransfer",
  "already-decided": "alreadyDecided",
  expired: "expired",
  "no-longer-valid": "noLongerValid",
};

async function send(method: "POST" | "PATCH" | "PUT", url: string, body: unknown) {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new MemberActionError("network");
  }
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const code =
      typeof json === "object" && json !== null && "error" in json ? json.error : undefined;
    const failure = typeof code === "string" ? failureByCode[code as MemberErrorCode] : undefined;
    throw new MemberActionError(failure ?? (response.status === 401 ? "signedOut" : "failed"));
  }
  return json;
}

// The answers are checked before use, so a changed server never yields half-understood data.
const roleResponseSchema = z.object({ role: z.enum(assignableRoles) });
const capabilitiesResponseSchema = z.object({
  capabilities: z.array(z.enum(delegableCapabilities)),
});
const startResponseSchema = z.object({ transfer: z.object({ id: z.string() }) });
const transferResponseSchema = z.object({
  outcome: z.enum(transferAnswers),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new MemberActionError("failed");
  return parsed.data;
}

export async function changeMemberRole(
  homeId: string,
  membershipId: string,
  input: RoleChangeInput,
): Promise<RoleChangeResponse> {
  return parse(
    roleResponseSchema,
    await send("PATCH", membersEndpoint(homeId, membershipId), input),
  );
}

export async function setMemberCapabilities(
  homeId: string,
  membershipId: string,
  input: CapabilitiesInput,
): Promise<CapabilitiesResponse> {
  return parse(
    capabilitiesResponseSchema,
    await send("PUT", `${membersEndpoint(homeId, membershipId)}/capabilities`, input),
  );
}

export async function removeMember(
  homeId: string,
  membershipId: string,
  input: RemovalInput,
): Promise<void> {
  await send("POST", `${membersEndpoint(homeId, membershipId)}/remove`, input);
}

export async function leaveHome(homeId: string): Promise<void> {
  await send("POST", leaveEndpoint(homeId), {});
}

export async function startOwnershipTransfer(
  homeId: string,
  input: StartTransferInput,
): Promise<StartTransferResponse> {
  return parse(startResponseSchema, await send("POST", transfersEndpoint(homeId), input));
}

export async function ownershipTransferAction(
  homeId: string,
  transferId: string,
  action: TransferAction,
): Promise<TransferActionResponse> {
  return parse(
    transferResponseSchema,
    await send("POST", transferActionEndpoint(homeId, transferId, action), {}),
  );
}
