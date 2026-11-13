import "server-only";

import type { User } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { PATH_HEADER } from "./path-header";
import {
  CHILD_HOME_PATH,
  CHILD_SIGN_IN_PATH,
  DISPLAY_PATH,
  REACTIVATE_PATH,
  signInPath,
  twoFactorPath,
} from "./redirects";
import { needsSecondFactor } from "./two-factor";
import { createSupabaseServerClient } from "./supabase-server";

export interface VerifiedIdentity {
  /** The stable account id. Never use a name, email or colour as an identity key. */
  readonly userId: string;
}

/**
 * Where this request's session stands, confirmed by Supabase Auth (architecture.md §7):
 *
 * - `signed-out`: no session, an invalid, expired or revoked one, or an unconfirmed email.
 * - `second-factor`: a valid sign-in of an account with two-factor sign-in that has not passed
 *   the authenticator code yet (S37), and is not a session of a trusted browser. It may only use
 *   the two-factor page.
 * - `deactivated`: a fully signed-in session of an account its holder deactivated (S38) or asked to
 *   delete (S40; `deletionPurgeAfter` then says until when it can be recovered). It may only use
 *   the reactivation page; the database refuses everything else for it.
 * - `child`: a guardian-managed child's session (S42), recognised by the `madeora_kind` the
 *   database sets in the account's app metadata (users cannot change it). It may only use the
 *   child pages; the database refuses it everything but the `child_*` functions, and only while
 *   Madeora registered the session and the child's guardians still allow it.
 * - `display`: a Household Display's session (S43), recognised the same way (`madeora_kind`
 *   `display`). It may only use the display page; the database refuses it everything but the
 *   `display_*` functions, and only while Madeora registered the session, the display is not
 *   revoked and its Home is open. It is never an adult or a member of any Home.
 * - `signed-in`: everything else.
 *
 * The session cookie is only a claim: `auth.getUser(token)` asks Supabase Auth to check the access
 * token's signature, expiry and that its session has not been revoked. The user object stored in
 * the cookie is never trusted; the assurance level is read from the token Supabase Auth has just
 * accepted, the authenticators from its answer. Cached for the rest of this request only.
 */
export type AuthState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "second-factor"; readonly user: User }
  | {
      readonly kind: "deactivated";
      readonly user: User;
      readonly deletionPurgeAfter: string | null;
    }
  | { readonly kind: "child"; readonly user: User }
  | { readonly kind: "display"; readonly user: User }
  | { readonly kind: "signed-in"; readonly user: User };

/** Whether a user Supabase Auth has just verified is a guardian-managed child (S42). */
export function isChildUser(user: Pick<User, "app_metadata">): boolean {
  return user.app_metadata["madeora_kind"] === "child";
}

/** Whether a user Supabase Auth has just verified is a Household Display (S43). */
export function isDisplayUser(user: Pick<User, "app_metadata">): boolean {
  return user.app_metadata["madeora_kind"] === "display";
}

export const getAuthState = cache(async (): Promise<AuthState> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { kind: "signed-out" };

  const { data, error } = await supabase.auth.getUser(session.access_token);
  if (error) return { kind: "signed-out" };
  // Before the email check: a child's alias is confirmed for Supabase Auth's sake only, and none of
  // the adult checks below apply to a child.
  if (isChildUser(data.user)) return { kind: "child", user: data.user };
  if (isDisplayUser(data.user)) return { kind: "display", user: data.user };
  if (!data.user.email_confirmed_at) return { kind: "signed-out" };
  if (needsSecondFactor(data.user, session.access_token)) {
    // A browser the account holder trusted (S37) passes the second factor for this session: the
    // database records the trust against the session, so the token stays aal1.
    const trusted = await supabase.rpc("session_is_trusted");
    if (trusted.error || !trusted.data) return { kind: "second-factor", user: data.user };
  }
  // S38: a deactivated account. When the state cannot be read, the database's own request check
  // still refuses the session everything, so "signed-in" never grants access by itself.
  const account = await supabase.rpc("my_account_state");
  const state = account.error ? undefined : account.data[0];
  if (state?.deactivated_at) {
    return {
      kind: "deactivated",
      user: data.user,
      deletionPurgeAfter: state.deletion_purge_after,
    };
  }
  return { kind: "signed-in", user: data.user };
});

/**
 * The signed-in person for this request, or `null` (also while the second factor is pending).
 * Accounts whose email is not confirmed do not count as signed in.
 */
export const getVerifiedIdentity = cache(async (): Promise<VerifiedIdentity | null> => {
  const user = await getVerifiedUser();
  return user ? { userId: user.id } : null;
});

/**
 * The confirmed account's record from Supabase Auth itself (email, sign-in identities,
 * authenticators), for the account holder's own settings. Same checks as `getVerifiedIdentity`.
 */
export const getVerifiedUser = cache(async (): Promise<User | null> => {
  const state = await getAuthState();
  return state.kind === "signed-in" ? state.user : null;
});

/**
 * For pages and layouts that need an account. Call it in every page as well as the layout: a
 * layout is not rendered again when someone moves between pages inside it. Signed-out visitors go
 * to the sign-in page, a pending second factor to the two-factor page (and both come back to the
 * requested page afterwards).
 */
export async function requireIdentity(): Promise<VerifiedIdentity> {
  const state = await getAuthState();
  if (state.kind === "signed-in") return { userId: state.user.id };
  if (state.kind === "deactivated") redirect(REACTIVATE_PATH);
  if (state.kind === "child") redirect(CHILD_HOME_PATH);
  if (state.kind === "display") redirect(DISPLAY_PATH);
  const path = (await headers()).get(PATH_HEADER);
  redirect(state.kind === "second-factor" ? twoFactorPath(path) : signInPath(path));
}

/** The signed-in child (S42), for the child pages. Anyone else goes where they belong. */
export async function requireChildIdentity(): Promise<VerifiedIdentity> {
  const state = await getAuthState();
  if (state.kind === "child") return { userId: state.user.id };
  if (state.kind === "signed-in") redirect("/");
  if (state.kind === "display") redirect(DISPLAY_PATH);
  if (state.kind === "deactivated") redirect(REACTIVATE_PATH);
  if (state.kind === "second-factor") redirect(twoFactorPath(null));
  redirect(CHILD_SIGN_IN_PATH);
}
