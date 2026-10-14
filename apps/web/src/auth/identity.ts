import "server-only";

import type { User } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { PATH_HEADER } from "./path-header";
import { signInPath } from "./redirects";
import { createSupabaseServerClient } from "./supabase-server";

export interface VerifiedIdentity {
  /** The stable account id. Never use a name, email or colour as an identity key. */
  readonly userId: string;
}

/**
 * The signed-in person for this request, confirmed by Supabase Auth, or `null`.
 *
 * The session cookie is only a claim: `auth.getUser(token)` asks Supabase Auth to check the access
 * token's signature, expiry and that its session has not been revoked (architecture.md §7). The
 * user object stored in the cookie is never trusted. Accounts whose email is not confirmed do not
 * count as signed in. Cached for the rest of this request only (React `cache`).
 */
export const getVerifiedIdentity = cache(async (): Promise<VerifiedIdentity | null> => {
  const user = await getVerifiedUser();
  return user ? { userId: user.id } : null;
});

/**
 * The confirmed account's record from Supabase Auth itself (email, sign-in identities), for the
 * account holder's own settings. Same checks and request cache as `getVerifiedIdentity`.
 */
export const getVerifiedUser = cache(async (): Promise<User | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  const { data, error } = await supabase.auth.getUser(session.access_token);
  if (error || !data.user.email_confirmed_at) return null;
  return data.user;
});

/**
 * For pages and layouts that need an account. Call it in every page as well as the layout: a
 * layout is not rendered again when someone moves between pages inside it. Signed-out visitors go to the sign-in page (and come
 * back to the requested page afterwards).
 */
export async function requireIdentity(): Promise<VerifiedIdentity> {
  const identity = await getVerifiedIdentity();
  if (!identity) redirect(signInPath((await headers()).get(PATH_HEADER)));
  return identity;
}
