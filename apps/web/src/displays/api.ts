import { z } from "zod";

import { homeEndpoint } from "@/homes/api";
import { MemberActionError, sendMemberRequest } from "@/members/manage-api";

import type { ApproveDisplayInput, CheckCodeInput, RenameDisplayInput } from "./schema";

/**
 * The HTTP contract of Household Display pairing (S43; versioned for later clients) and the
 * browser's callers for it. Same CSRF, content-type and size checks as the rest of `/api/v1`.
 *
 * The tablet (no session; refused with `409 signed-in` when any member, child or display session
 * is in this browser):
 * - `POST /api/v1/display/pairing` `{ renew }` → `200 { status: "pending", code, expiresAt }`,
 *   `200 { status: "expired" }`, or `200 { status: "paired" }` (the display session cookies are
 *   now set); `429 rate-limited`, `503 unavailable`. `renew: true` throws the current code away.
 *
 * The paired display:
 * - `POST /api/v1/display/heartbeat` `{}` → `200 { displayName, homeName, homeTimezone }`;
 *   `401 not-paired` (revoked, Home closed: go back to the pairing screen), `503 unavailable`.
 * - `POST /api/v1/display/reset` `{}` → `200 {}` after signing out a session the database no longer
 *   accepts; `409 paired` while it still works (a working display is never signed out here).
 *
 * Home managers (Owner, or Administrator with manageHomeSettings; the database decides again):
 * - `POST /api/v1/homes/{homeId}/displays/check` `{ code }` → `200 { request: { id, deviceKind,
 *   browser, platform, requestedAt, expiresAt } }`; `404 invalid-code`, `409 expired`,
 *   `409 already-used`, `429 rate-limited`
 * - `POST /api/v1/homes/{homeId}/displays` `{ requestId, code, name }` → `201 { display: { id } }`;
 *   the same refusals and `429 limit-reached`
 * - `POST /api/v1/homes/{homeId}/displays/{displayId}/rename` `{ name }` → `200 {}`
 * - `POST /api/v1/homes/{homeId}/displays/{displayId}/revoke` `{}` → `200 {}`
 */

export const DISPLAY_PAIRING_ENDPOINT = "/api/v1/display/pairing";
export const DISPLAY_HEARTBEAT_ENDPOINT = "/api/v1/display/heartbeat";
export const DISPLAY_RESET_ENDPOINT = "/api/v1/display/reset";

export type PairingState =
  | { readonly status: "pending"; readonly code: string; readonly expiresAt: string }
  | { readonly status: "expired" }
  | { readonly status: "paired" }
  | { readonly status: "signed-in" }
  | { readonly status: "rate-limited" }
  | { readonly status: "unavailable" }
  | { readonly status: "network" };

const pairingBodySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), code: z.string(), expiresAt: z.string() }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("paired") }),
]);
const errorSchema = z.object({ error: z.string() });

async function post(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return null;
  }
}

/** The tablet's pairing state, after resuming its code or (`renew`) asking for a new one. */
export async function requestPairing(renew: boolean): Promise<PairingState> {
  const response = await post(DISPLAY_PAIRING_ENDPOINT, { renew });
  if (!response) return { status: "network" };
  const body: unknown = await response.json().catch(() => ({}));
  if (response.ok) {
    const parsed = pairingBodySchema.safeParse(body);
    return parsed.success ? parsed.data : { status: "unavailable" };
  }
  const error = errorSchema.safeParse(body);
  if (error.success && error.data.error === "rate-limited") return { status: "rate-limited" };
  if (error.success && error.data.error === "signed-in") return { status: "signed-in" };
  return { status: "unavailable" };
}

export type HeartbeatResult = "ok" | "not-paired" | "offline";

/** Whether the server still accepts this display (`offline`: it could not be asked). */
export async function sendHeartbeat(): Promise<HeartbeatResult> {
  const response = await post(DISPLAY_HEARTBEAT_ENDPOINT, {});
  if (!response) return "offline";
  if (response.ok) return "ok";
  return response.status === 401 ? "not-paired" : "offline";
}

/** Signs out a display session the server no longer accepts. */
export async function resetDisplay(): Promise<boolean> {
  const response = await post(DISPLAY_RESET_ENDPOINT, {});
  return response?.ok ?? false;
}

// Home managers ---------------------------------------------------------------------------------

export function displaysEndpoint(homeId: string): string {
  return `${homeEndpoint(homeId)}/displays`;
}

export interface PairingReview {
  readonly id: string;
  readonly deviceKind: string;
  readonly browser: string;
  readonly platform: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

const reviewSchema = z.object({
  request: z.object({
    id: z.uuid(),
    deviceKind: z.string(),
    browser: z.string(),
    platform: z.string(),
    requestedAt: z.string(),
    expiresAt: z.string(),
  }),
});

export async function checkPairingCode(
  homeId: string,
  input: CheckCodeInput,
): Promise<PairingReview> {
  const parsed = reviewSchema.safeParse(
    await sendMemberRequest("POST", `${displaysEndpoint(homeId)}/check`, input),
  );
  if (!parsed.success) throw new MemberActionError("failed");
  return parsed.data.request;
}

export async function approveDisplay(homeId: string, input: ApproveDisplayInput): Promise<void> {
  await sendMemberRequest("POST", displaysEndpoint(homeId), input);
}

export async function renameDisplay(
  homeId: string,
  displayId: string,
  input: RenameDisplayInput,
): Promise<void> {
  await sendMemberRequest(
    "POST",
    `${displaysEndpoint(homeId)}/${encodeURIComponent(displayId)}/rename`,
    input,
  );
}

export async function revokeDisplay(homeId: string, displayId: string): Promise<void> {
  await sendMemberRequest(
    "POST",
    `${displaysEndpoint(homeId)}/${encodeURIComponent(displayId)}/revoke`,
    {},
  );
}
