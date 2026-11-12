import { z } from "zod";

import { childEndpoint } from "@/children/api";
import { homeEndpoint } from "@/homes/api";
import { MemberActionError, sendMemberRequest } from "@/members/manage-api";

import type {
  ApproveDeviceInput,
  ChildSignInActionInput,
  PasswordSignInInput,
  PinSignInInput,
} from "./schema";

/**
 * The HTTP contract of child sign-in (S42; versioned for later mobile clients) and the browser's
 * callers for it. Same CSRF, content-type and size checks as the rest of `/api/v1`.
 *
 * Signing in (no session needed; any session in this browser is replaced):
 * - `POST /api/v1/child-sign-in/password` `{ username, password }` → `200 {}` and session cookies
 * - `POST /api/v1/child-sign-in/pin` `{ childMembershipId, pin }`, approved device cookie only
 *   → `200 {}` and session cookies
 *   Refusals: `401 invalid-credentials` (wrong or unknown, never told apart), `423 locked`
 *   `{ until }` (`null`: until a guardian unlocks), `429 rate-limited`, `403 not-enabled` (right
 *   secret, sign-in off), `403 device-not-approved`, `409 signed-in` (an adult is signed in here),
 *   `503 unavailable`.
 * Signing out is the ordinary `POST /auth/sign-out` form (`then=child` or `then=household`).
 *
 * Guardians (`requireChildAction` rules, database decides again):
 * - `POST /api/v1/homes/{homeId}/children/{membershipId}/sign-in` `ChildSignInActionInput`
 *   → `200 { outcome }`; `409 username-taken`, `409 username-required`
 *
 * Home managers (Owner, or Administrator with manageHomeSettings):
 * - `POST /api/v1/homes/{homeId}/household-devices` `{ label }` → `201 { device: { id } }` and the
 *   httpOnly device cookie on this browser
 * - `POST /api/v1/homes/{homeId}/household-devices/{deviceId}/revoke` `{}` → `200 {}`
 */

export const CHILD_PASSWORD_SIGN_IN_ENDPOINT = "/api/v1/child-sign-in/password";
export const CHILD_PIN_SIGN_IN_ENDPOINT = "/api/v1/child-sign-in/pin";

export type ChildSignInErrorCode =
  | "invalid-credentials"
  | "locked"
  | "rate-limited"
  | "not-enabled"
  | "device-not-approved"
  | "signed-in"
  | "unavailable"
  | "invalid"
  | "forbidden"
  | "unsupported-media-type"
  | "too-large";

export type ChildSignInFailure =
  | { readonly kind: "invalidCredentials" }
  | { readonly kind: "locked"; readonly until: string | null }
  | { readonly kind: "rateLimited" }
  | { readonly kind: "notEnabled" }
  | { readonly kind: "deviceNotApproved" }
  | { readonly kind: "signedIn" }
  | { readonly kind: "network" }
  | { readonly kind: "failed" };

const failureByCode: Partial<Record<ChildSignInErrorCode, ChildSignInFailure["kind"]>> = {
  "invalid-credentials": "invalidCredentials",
  invalid: "invalidCredentials",
  "rate-limited": "rateLimited",
  "not-enabled": "notEnabled",
  "device-not-approved": "deviceNotApproved",
  "signed-in": "signedIn",
};

const errorBodySchema = z.object({
  error: z.string(),
  until: z.string().nullable().optional(),
});

/** Signs a child in; resolves when the session cookies are set, otherwise returns why not. */
async function postSignIn(url: string, body: unknown): Promise<ChildSignInFailure | null> {
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
    return { kind: "network" };
  }
  if (response.ok) return null;
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => ({})));
  if (!parsed.success) return { kind: "failed" };
  if (parsed.data.error === "locked") return { kind: "locked", until: parsed.data.until ?? null };
  const kind = failureByCode[parsed.data.error as ChildSignInErrorCode];
  if (!kind || kind === "locked") return { kind: "failed" };
  return { kind };
}

export function signInChildWithPassword(
  input: PasswordSignInInput,
): Promise<ChildSignInFailure | null> {
  return postSignIn(CHILD_PASSWORD_SIGN_IN_ENDPOINT, input);
}

export function signInChildWithPin(input: PinSignInInput): Promise<ChildSignInFailure | null> {
  return postSignIn(CHILD_PIN_SIGN_IN_ENDPOINT, input);
}

// Guardians -------------------------------------------------------------------------------------

export const childSignInOutcomes = ["saved", "unchanged", "cleared", "unlocked", "ended"] as const;
export type ChildSignInOutcome = (typeof childSignInOutcomes)[number];

const outcomeSchema = z.object({ outcome: z.enum(childSignInOutcomes) });

export async function changeChildSignIn(
  homeId: string,
  membershipId: string,
  input: ChildSignInActionInput,
): Promise<ChildSignInOutcome> {
  const parsed = outcomeSchema.safeParse(
    await sendMemberRequest("POST", `${childEndpoint(homeId, membershipId)}/sign-in`, input),
  );
  if (!parsed.success) throw new MemberActionError("failed");
  return parsed.data.outcome;
}

// Household devices -----------------------------------------------------------------------------------

export function householdDevicesEndpoint(homeId: string): string {
  return `${homeEndpoint(homeId)}/household-devices`;
}

export async function approveHouseholdDevice(
  homeId: string,
  input: ApproveDeviceInput,
): Promise<void> {
  await sendMemberRequest("POST", householdDevicesEndpoint(homeId), input);
}

export async function revokeHouseholdDevice(homeId: string, deviceId: string): Promise<void> {
  await sendMemberRequest(
    "POST",
    `${householdDevicesEndpoint(homeId)}/${encodeURIComponent(deviceId)}/revoke`,
    {},
  );
}
