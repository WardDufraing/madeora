import type { Database } from "@madeora/database";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getMemoryOnlySupabaseClient, getSupabaseBrowserClient } from "./supabase-browser";
import { readAccessTokenClaims } from "./two-factor";

/**
 * Recent reauthentication before a sensitive change (S08, extended in S37): a fresh password
 * sign-in in a memory-only client and, when the account has two-factor sign-in, a TOTP
 * verification. With it, `authorize` asks the database for a one-time permission
 * (`authorize_account_change` or `authorize_sign_in_method_change`), which checks all of this
 * again itself. The permission is bound to the browser's own session (`mainSessionId`), so no
 * other session of the account can use it. The browser's own session is never replaced, and the
 * extra session is signed out straight away, whatever happens.
 *
 * Supabase Auth ends every aal1 session of the account when a code is verified, so where the code
 * is verified matters. Normally the browser's own session is already aal2: the code is verified
 * on the extra session, after the password. A trusted browser's own session is aal1 (it skipped
 * the code at sign-in): the code is verified on it first, which makes it aal2, and only then does
 * the extra session start, so neither ends the other.
 */
export interface ReauthenticationInput {
  readonly email: string;
  readonly password: string;
  /** The authenticator code, or null when the account has no two-factor sign-in. */
  readonly code: string | null;
  readonly captchaOptions: { readonly captchaToken?: string };
}

/** Which step failed, so the form can name it: the password, the code or the permission. */
export type ReauthenticationError =
  | { readonly step: "password"; readonly error: unknown }
  | { readonly step: "code"; readonly error: unknown }
  | { readonly step: "authorize"; readonly error: unknown };

export type Authorize = (
  client: SupabaseClient<Database>,
  mainSessionId: string,
) => PromiseLike<{ readonly error: unknown }>;

/** The browser's own session (from its access token): its id and level, or null when signed out. */
async function mainSession(): Promise<{ readonly id: string; readonly aal2: boolean } | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  if (!data.session) return null;
  const claims = readAccessTokenClaims(data.session.access_token);
  return claims.sessionId ? { id: claims.sessionId, aal2: claims.aal === "aal2" } : null;
}

/** Verifies the authenticator code on `client`'s session, which is then aal2. */
async function verifyCode(
  client: SupabaseClient<Database>,
  code: string,
): Promise<ReauthenticationError | null> {
  const { data, error: listError } = await client.auth.mfa.listFactors();
  const factor = data?.totp[0]; // Supabase lists only verified TOTP factors here.
  if (listError || !factor) return { step: "code", error: listError };
  const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  return error ? { step: "code", error } : null;
}

export async function reauthenticate(
  input: ReauthenticationInput,
  authorize: Authorize,
): Promise<ReauthenticationError | null> {
  const main = await mainSession();
  if (!main) return { step: "authorize", error: null };
  // A trusted browser: the code first, on the browser's own session (see above).
  const codeFirst = input.code !== null && !main.aal2;
  if (codeFirst) {
    const failed = await verifyCode(getSupabaseBrowserClient(), input.code);
    if (failed) return failed;
  }
  const client = getMemoryOnlySupabaseClient("reauthentication");
  try {
    const { error: signInError } = await client.auth.signInWithPassword({
      email: input.email,
      password: input.password,
      options: input.captchaOptions,
    });
    if (signInError) return { step: "password", error: signInError };
    if (!codeFirst && input.code !== null) {
      const failed = await verifyCode(client, input.code);
      if (failed) return failed;
    }
    const { error } = await authorize(client, main.id);
    return error ? { step: "authorize", error } : null;
  } finally {
    await client.auth.signOut({ scope: "local" });
  }
}
