import { z } from "zod";

import { getGoogleReauthClient, getSupabaseBrowserClient } from "./supabase-browser";
import { readAccessTokenClaims } from "./two-factor";

/**
 * Confirming a sensitive change with Google (S37), for accounts that sign in only with Google and
 * so have no password to type again. The browser goes to Google (which asks which account to use)
 * and back to `/auth/reauthenticate`, which opens a short-lived session in its own client, asks
 * for the authenticator code when two-factor sign-in is on, and asks the database for the same
 * one-time permission a password reauthentication gives. The database checks the fresh Google
 * sign-in, the code and that both sessions are this account's.
 *
 * Supabase Auth ends every aal1 session of the account when a code is verified. Normally the
 * browser's own session is aal2, so the code is verified on the Google session after Google. A
 * trusted browser's own session is aal1: the code is verified on it before leaving for Google
 * (`twoFactor` is then false in what is pending), so neither session ends the other.
 */

/** The database's account-change permissions (supabase/migrations/…_adult_security.sql). */
export const ACCOUNT_CHANGE_ACTIONS = [
  "password",
  "email",
  "two_factor_enroll",
  "two_factor_disable",
  "recovery_codes",
  "backup_email",
  "account_recovery_codes",
  // S38: requesting and downloading a security report.
  "security_report",
  // S38: temporary account deactivation.
  "deactivate_account",
  // S39: requesting and downloading a personal data export.
  "data_export",
  // S40: account deletion, and closing or restoring a Home.
  "delete_account",
  "close_home",
] as const;
export type AccountChangeAction = (typeof ACCOUNT_CHANGE_ACTIONS)[number];

export function parseAccountChangeAction(value: unknown): AccountChangeAction | null {
  return (ACCOUNT_CHANGE_ACTIONS as readonly unknown[]).includes(value)
    ? (value as AccountChangeAction)
    : null;
}

/** Where on Settings › Security each change lives, to come back to it. */
export function sectionOf(action: AccountChangeAction): string {
  switch (action) {
    case "password":
      return "password";
    case "email":
      return "email";
    case "two_factor_enroll":
    case "two_factor_disable":
    case "recovery_codes":
      return "two-factor";
    case "backup_email":
    case "account_recovery_codes":
      return "recovery";
    case "security_report":
      return "report";
    case "deactivate_account":
      return "deactivate";
    case "data_export":
      return "export";
    case "delete_account":
      return "delete";
    case "close_home":
      return "close";
  }
}

/**
 * Pages other than the action's own that may ask to be returned to: a Home's export page (S39), a
 * Home's close page and the closed Homes page (S40).
 */
const RETURN_PATH =
  /^(?:\/homes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:export|close)|\/settings\/closed-homes)$/;

export function isReturnPath(value: unknown): value is string {
  return typeof value === "string" && RETURN_PATH.test(value);
}

/**
 * The page to return to once `action` is permitted: it opens that change without asking again.
 * A data export started on a Home's export page returns there (`returnPath`).
 */
export function confirmedPath(action: AccountChangeAction, returnPath?: string): string {
  if (isReturnPath(returnPath)) {
    const exportPage = returnPath.endsWith("/export");
    if (action === "data_export" ? exportPage : action === "close_home" && !exportPage) {
      return `${returnPath}?confirmed=${action}`;
    }
  }
  // S38: the report lives on Settings › Security › Security activity.
  if (action === "security_report") {
    return `/settings/security/activity?confirmed=${action}#${sectionOf(action)}`;
  }
  if (action === "deactivate_account") return `/settings/security/deactivate?confirmed=${action}`;
  // S39: data exports live on Settings › Privacy › Export your data.
  if (action === "data_export") return `/settings/privacy/export?confirmed=${action}`;
  // S40: account deletion lives on Settings › Privacy; closing and restoring Homes on their pages.
  if (action === "delete_account") return `/settings/privacy/delete?confirmed=${action}`;
  if (action === "close_home") return `/settings/closed-homes?confirmed=${action}`;
  return `/settings/security?confirmed=${action}#${sectionOf(action)}`;
}

export const PENDING_KEY = "madeora-google-reauthentication-pending";

const pendingSchema = z.object({
  action: z.enum(ACCOUNT_CHANGE_ACTIONS),
  userId: z.string().min(1),
  twoFactor: z.boolean(),
  returnPath: z.string().refine(isReturnPath).optional(),
});
export type PendingGoogleReauth = z.infer<typeof pendingSchema>;

/** Reads (and removes) what this tab started; null when nothing or something unreadable. */
export function takePending(): PendingGoogleReauth | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    window.sessionStorage.removeItem(PENDING_KEY);
    if (raw === null) return null;
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True when the browser's own session has passed two-factor sign-in (not a trusted browser's aal1). */
export async function browserSessionIsAal2(): Promise<boolean> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session ? readAccessTokenClaims(data.session.access_token).aal === "aal2" : false;
}

/**
 * Verifies the authenticator code on the browser's own session (`"browser"`, before Google on a
 * trusted browser) or on the Google session (`"google"`, after Google). `noFactor` when the
 * account has no verified authenticator any more.
 */
export async function verifyReauthCode(
  where: "browser" | "google",
  code: string,
): Promise<{ readonly error: unknown; readonly noFactor: boolean }> {
  const client = where === "browser" ? getSupabaseBrowserClient() : getGoogleReauthClient();
  const { data, error: listError } = await client.auth.mfa.listFactors();
  const factor = data?.totp[0]; // Supabase lists only verified TOTP factors here.
  if (listError || !factor) return { error: listError, noFactor: true };
  const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  return { error, noFactor: false };
}

/** Leaves for Google. Resolves with an error only if it could not start. */
export async function startGoogleReauth(
  pending: PendingGoogleReauth,
  email: string,
): Promise<{ readonly error: unknown }> {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch (error) {
    return { error };
  }
  const { error } = await getGoogleReauthClient().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: new URL("/auth/reauthenticate", window.location.origin).toString(),
      // Google asks which account to use and suggests this account's, so a shared device never
      // confirms with whichever Google account happens to be signed in there.
      queryParams: { prompt: "select_account", login_hint: email },
    },
  });
  return { error };
}

export type GoogleReauthFailure =
  "cancelled" | "nothingPending" | "otherAccount" | "refused" | "failed";

/** Opens the short-lived Google session from the callback's code; checks it is this account's. */
export async function openGoogleReauthSession(
  pending: PendingGoogleReauth,
  code: string | null,
): Promise<GoogleReauthFailure | null> {
  if (code === null || code === "") return "cancelled";
  const reauth = getGoogleReauthClient();
  const { data, error } = await reauth.auth.exchangeCodeForSession(code);
  if (error) return "failed";
  const { data: main } = await getSupabaseBrowserClient().auth.getUser();
  if (data.user.id !== pending.userId || main.user?.id !== pending.userId) {
    await reauth.auth.signOut({ scope: "local" });
    return "otherAccount";
  }
  return null;
}

/**
 * With the Google session open (and the code verified if needed),
 * asks for the permission bound to the browser's own session, then ends the Google session.
 */
export async function authorizeAfterGoogle(action: AccountChangeAction): Promise<boolean> {
  const reauth = getGoogleReauthClient();
  try {
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    const sessionId = data.session
      ? readAccessTokenClaims(data.session.access_token).sessionId
      : null;
    if (!sessionId) return false;
    const { error } = await reauth.rpc("authorize_account_change", {
      p_action: action,
      p_session_id: sessionId,
    });
    return !error;
  } finally {
    await reauth.auth.signOut({ scope: "local" });
  }
}

/** Ends the Google session without asking for anything (the person gave up at the code step). */
export async function abandonGoogleReauth(): Promise<void> {
  await getGoogleReauthClient().auth.signOut({ scope: "local" });
}
