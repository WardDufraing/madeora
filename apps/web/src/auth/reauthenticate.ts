import type { Database } from "@madeora/database";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getMemoryOnlySupabaseClient, getSupabaseBrowserClient } from "./supabase-browser";
import { readAccessTokenClaims } from "./two-factor";

/**
 * Recent reauthentication before a sensitive change (S08, extended in S37): a fresh password
 * sign-in in a memory-only client and, when the account has two-factor sign-in, a TOTP
 * verification on the browser's own session (which then counts as aal2 for Supabase Auth too, as
 * a trusted browser's session would not otherwise be). With it, `authorize` asks the database for a one-time
 * permission (`authorize_account_change` or `authorize_sign_in_method_change`), which checks all of
 * this again itself. The permission is bound to the browser's own session (`mainSessionId`), so no
 * other session of the account can use it. The browser's own session is never replaced, and the
 * extra session is signed out straight away, whatever happens.
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

/** The id of the browser's own session (from its access token), or null when signed out. */
async function mainSessionId(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session ? readAccessTokenClaims(data.session.access_token).sessionId : null;
}

export async function reauthenticate(
  input: ReauthenticationInput,
  authorize: Authorize,
): Promise<ReauthenticationError | null> {
  const sessionId = await mainSessionId();
  if (!sessionId) return { step: "authorize", error: null };
  const client = getMemoryOnlySupabaseClient("reauthentication");
  const { error: signInError } = await client.auth.signInWithPassword({
    email: input.email,
    password: input.password,
    options: input.captchaOptions,
  });
  if (signInError) return { step: "password", error: signInError };
  try {
    if (input.code !== null) {
      const main = getSupabaseBrowserClient();
      const { data, error: listError } = await main.auth.mfa.listFactors();
      const factor = data?.totp[0]; // Supabase lists only verified TOTP factors here.
      if (listError || !factor) return { step: "code", error: listError };
      const { error: verifyError } = await main.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code: input.code,
      });
      if (verifyError) return { step: "code", error: verifyError };
    }
    const { error } = await authorize(client, sessionId);
    return error ? { step: "authorize", error } : null;
  } finally {
    await client.auth.signOut({ scope: "local" });
  }
}
