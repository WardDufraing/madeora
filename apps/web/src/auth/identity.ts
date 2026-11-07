import "server-only";

import type { User } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { PATH_HEADER } from "./path-header";
import { REACTIVATE_PATH, signInPath, twoFactorPath } from "./redirects";
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
 * - `deactivated`: a fully signed-in session of an account its holder deactivated (S38). It may
 *   only use the reactivation page; the database refuses everything else for it.
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
  | { readonly kind: "deactivated"; readonly user: User }
  | { readonly kind: "signed-in"; readonly user: User };

export const getAuthState = cache(async (): Promise<AuthState> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { kind: "signed-out" };

  const { data, error } = await supabase.auth.getUser(session.access_token);
  if (error || !data.user.email_confirmed_at) return { kind: "signed-out" };
  if (needsSecondFactor(data.user, session.access_token)) {
    // A browser the account holder trusted (S37) passes the second factor for this session: the
    // database records the trust against the session, so the token stays aal1.
    const trusted = await supabase.rpc("session_is_trusted");
    if (trusted.error || !trusted.data) return { kind: "second-factor", user: data.user };
  }
  // S38: a deactivated account. When the state cannot be read, the database's own request check
  // still refuses the session everything, so "signed-in" never grants access by itself.
  const account = await supabase.rpc("my_account_state");
  if (!account.error && account.data[0]?.deactivated_at) {
    return { kind: "deactivated", user: data.user };
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
  const path = (await headers()).get(PATH_HEADER);
  redirect(state.kind === "second-factor" ? twoFactorPath(path) : signInPath(path));
}
