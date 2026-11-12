import "server-only";

import { parseEnv } from "@madeora/config/env";
import { getPublicEnv } from "@madeora/config/env/public";
import type { Database } from "@madeora/database";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import { dummyChildSecretHash, verifyChildSecret } from "./secret-hash";

/**
 * Signing a child in (S42, architecture.md §7 and §34). The web server checks the password or PIN
 * against the scrypt hash the database hands it (service role only), then has Supabase Auth issue
 * an ordinary session for the child's internal alias and registers that session in the database,
 * which is what makes the child's token usable at all. No PIN, password, hash, username or address
 * is ever logged: events carry a name and, at most, a database error code.
 */

// A Supabase secret API key, or the legacy service_role JWT (as storage/config.ts).
const SERVICE_KEY = /^(?:sb_secret_[A-Za-z0-9_-]{20,200}|eyJ[\w-]+\.[\w-]+\.[\w-]+)$/;
const serviceEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().regex(SERVICE_KEY).optional(),
});

let cached: { readonly client: SupabaseClient<Database>; readonly key: string } | null | undefined;

/** The service-role client, or `null` where this environment has no secret key configured. */
function service(): { readonly client: SupabaseClient<Database>; readonly key: string } | null {
  if (cached !== undefined) return cached;
  const key = parseEnv(serviceEnvSchema, process.env).SUPABASE_SERVICE_ROLE_KEY;
  cached = key
    ? {
        key,
        client: createClient<Database>(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL, key, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        }),
      }
    : null;
  return cached;
}

/** The service-role client for the other household-device flows (`null`: not configured). */
export function householdService(): SupabaseClient<Database> | null {
  try {
    return service()?.client ?? null;
  } catch {
    return null;
  }
}

/** The client-address key for the database's per-client throttles (see `clientKey`). */
export async function householdClientKey(): Promise<string | null> {
  const found = service();
  return found ? clientKey(found.key) : null;
}

/** Whether child sign-in can work here (the server has the Supabase secret key). */
export function childSignInAvailable(): boolean {
  try {
    return service() !== null;
  } catch {
    return false;
  }
}

/**
 * A key for the client's address, for the database's per-client throttle: an HMAC with the server
 * secret, so the stored value cannot be reversed into an address by trying them all.
 */
async function clientKey(secret: string): Promise<string> {
  const requestHeaders = await headers();
  const address =
    requestHeaders.get("x-real-ip") ??
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return createHmac("sha256", secret).update(`child-sign-in-client:${address}`).digest("hex");
}

export type ChildSignInResult =
  | { readonly kind: "signed-in" }
  | { readonly kind: "invalid" }
  /** `until` is `null` when only a guardian can unlock. */
  | { readonly kind: "locked"; readonly until: string | null }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "not-enabled" }
  | { readonly kind: "device-not-approved" }
  | { readonly kind: "unavailable" };

interface AttemptRow {
  readonly outcome: string;
  readonly attempt_id: string | null;
  readonly locked_until: string | null;
}

function log(event: string, code?: string): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

/** The `session_id` claim of an access token Supabase Auth has just returned to this server. */
function sessionIdOf(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const id =
      typeof claims === "object" && claims !== null && "session_id" in claims
        ? claims.session_id
        : null;
    return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Steps 2 and 3, once the secret matched: issue the session and register it. */
async function issueSession(
  client: SupabaseClient<Database>,
  attemptId: string,
): Promise<ChildSignInResult> {
  const verified = await client.rpc("child_sign_in_verified", { p_attempt_id: attemptId });
  if (verified.error) {
    log("child_sign_in.verify_failed", verified.error.code);
    return { kind: "unavailable" };
  }
  const row = verified.data[0];
  if (row?.outcome === "not_enabled") return { kind: "not-enabled" };
  if (row?.outcome === "not_configured") {
    log("child_sign_in.not_configured");
    return { kind: "unavailable" };
  }
  if (row?.outcome !== "verified" || !row.alias_email) return { kind: "invalid" };

  const link = await client.auth.admin.generateLink({ type: "magiclink", email: row.alias_email });
  const tokenHash = link.data.properties?.hashed_token;
  if (link.error || !tokenHash) {
    log("child_sign_in.link_failed", link.error?.code);
    return { kind: "unavailable" };
  }
  // Sets the session cookies on this response, replacing any session this browser had.
  const supabase = await createSupabaseServerClient();
  const otp = await supabase.auth.verifyOtp({ type: "email", token_hash: tokenHash });
  const session = otp.data.session;
  if (otp.error || !session) {
    log("child_sign_in.session_failed", otp.error?.code);
    return { kind: "unavailable" };
  }
  const sessionId = sessionIdOf(session.access_token);
  const completed = sessionId
    ? await client.rpc("child_sign_in_complete", {
        p_attempt_id: attemptId,
        p_session_id: sessionId,
      })
    : null;
  if (!completed || completed.error || completed.data[0]?.outcome !== "registered") {
    log("child_sign_in.register_failed", completed?.error?.code);
    // The database would refuse the unregistered session anyway; end it so nothing lingers.
    await supabase.auth.signOut({ scope: "local" });
    return { kind: "unavailable" };
  }
  return { kind: "signed-in" };
}

async function checkAttempt(
  client: SupabaseClient<Database>,
  attempt: { readonly data: AttemptRow | undefined; readonly hash: string | null },
  secret: string,
): Promise<ChildSignInResult> {
  const row = attempt.data;
  switch (row?.outcome) {
    case "rate_limited":
      return { kind: "rate-limited" };
    case "device_not_approved":
      return { kind: "device-not-approved" };
    case "locked":
      return {
        kind: "locked",
        until: row.locked_until && row.locked_until !== "infinity" ? row.locked_until : null,
      };
    case "unknown":
      // Same work and answer as a wrong secret, so the two cannot be told apart.
      await verifyChildSecret(secret, await dummyChildSecretHash());
      return { kind: "invalid" };
    case "check":
      if (!row.attempt_id || !attempt.hash) return { kind: "unavailable" };
      if (!(await verifyChildSecret(secret, attempt.hash))) return { kind: "invalid" };
      return issueSession(client, row.attempt_id);
    default:
      return { kind: "unavailable" };
  }
}

/** Username and password, anywhere the child's primary guardian allowed independent sign-in. */
export async function signInChildWithPassword(
  username: string,
  password: string,
): Promise<ChildSignInResult> {
  const found = service();
  if (!found) return { kind: "unavailable" };
  const { data, error } = await found.client.rpc("child_password_attempt", {
    p_username: username.trim().toLowerCase(),
    p_client_key: await clientKey(found.key),
  });
  if (error) {
    log("child_sign_in.attempt_failed", error.code);
    return { kind: "unavailable" };
  }
  const row = data[0];
  return checkAttempt(found.client, { data: row, hash: row?.password_hash ?? null }, password);
}

/** A PIN, only on an approved household device and only for a child of its Home. */
export async function signInChildWithPin(
  deviceHash: string,
  childMembershipId: string,
  pin: string,
): Promise<ChildSignInResult> {
  const found = service();
  if (!found) return { kind: "unavailable" };
  const { data, error } = await found.client.rpc("child_pin_attempt", {
    p_device_hash: deviceHash,
    p_child_membership_id: childMembershipId,
    p_client_key: await clientKey(found.key),
  });
  if (error) {
    log("child_sign_in.attempt_failed", error.code);
    return { kind: "unavailable" };
  }
  const row = data[0];
  return checkAttempt(found.client, { data: row, hash: row?.pin_hash ?? null }, pin);
}

export interface HouseholdDeviceScreen {
  readonly homeName: string;
  readonly deviceLabel: string;
  readonly children: readonly {
    readonly membershipId: string;
    readonly name: string;
    readonly accentColor: string | null;
  }[];
}

/**
 * What an approved device's PIN screen shows: its Home and the children who can use a PIN there.
 * `null` for an unknown or revoked device; `undefined` when it cannot be read now.
 */
export async function getHouseholdDeviceScreen(
  deviceHash: string,
): Promise<HouseholdDeviceScreen | null | undefined> {
  const found = service();
  if (!found) return undefined;
  const { data, error } = await found.client.rpc("household_device_sign_in", {
    p_device_hash: deviceHash,
  });
  if (error) {
    log("child_sign_in.device_screen_failed", error.code);
    return undefined;
  }
  const first = data[0];
  if (!first) return null;
  return {
    homeName: first.home_name,
    deviceLabel: first.device_label,
    children: data.flatMap((row) =>
      row.child_membership_id
        ? [
            {
              membershipId: row.child_membership_id,
              name: row.child_name,
              accentColor: row.child_accent_color,
            },
          ]
        : [],
    ),
  };
}
