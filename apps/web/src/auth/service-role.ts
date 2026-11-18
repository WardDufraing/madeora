import "server-only";

import { getPublicEnv } from "@madeora/config/env/public";
import type { Database } from "@madeora/database";
import { createClient } from "@supabase/supabase-js";

/**
 * The only way the web app reaches Supabase with the service-role key (owner decision S15-M3, ADR
 * 0019 note): a client limited to the server functions below and to minting a magic link for a
 * child's or display's internal alias. Everything else runs as the signed-in person, under RLS.
 * `service-role.test.ts` fails when another file creates a Supabase client from
 * `@supabase/supabase-js` with a secret key, imports this module without being listed there, or
 * calls a function that is not on this list.
 *
 * Each listed function checks its own inputs and is executable by `service_role` only:
 * - child sign-in (S42): password and PIN attempts, the verified secret, registering the session;
 * - shared household devices (S42b): the board, chore attempts, verification and undo;
 * - Household Displays (S43): pairing, chore and lock PINs;
 * - child-to-adult transition links (S44), opened by someone who is not signed in;
 * - finalizing an upload or photo once the server has checked the stored object (S15, S35).
 */
export const SERVICE_ROLE_RPCS = [
  "child_password_attempt",
  "child_pin_attempt",
  "child_sign_in_verified",
  "child_sign_in_complete",
  "household_device_sign_in",
  "shared_device_board",
  "shared_device_attempt",
  "shared_device_verified",
  "shared_device_undo",
  "display_pairing_start",
  "display_pairing_status",
  "display_pairing_cancel",
  "display_pairing_claim",
  "display_pairing_complete",
  "display_chore_attempt",
  "display_chore_verified",
  "display_chore_undo",
  "display_lock_attempt",
  "display_lock_verified",
  "child_transition_preview",
  "claim_child_transition",
  "child_transition_review",
  "complete_child_transition",
  "finalize_upload",
  "finalize_photo",
] as const satisfies readonly (keyof Database["public"]["Functions"])[];

export type ServiceRoleRpc = (typeof SERVICE_ROLE_RPCS)[number];

type Functions = Database["public"]["Functions"];

export function isServiceRoleRpc(name: string): name is ServiceRoleRpc {
  return (SERVICE_ROLE_RPCS as readonly string[]).includes(name);
}

function createService(key: string) {
  return createClient<Database>(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** The narrowed service-role client: listed functions and alias magic links, nothing else. */
export interface ServiceRoleClient {
  rpc<F extends ServiceRoleRpc>(
    fn: F,
    args: Functions[F]["Args"],
  ): Promise<
    | { readonly data: Functions[F]["Returns"]; readonly error: null }
    | { readonly data: null; readonly error: { readonly code: string } }
  >;
  /** A one-time sign-in link's hashed token for an internal alias address (child or display). */
  magicLinkToken(
    email: string,
  ): Promise<
    | { readonly tokenHash: string; readonly error: null }
    | { readonly tokenHash: null; readonly error: { readonly code: string | undefined } }
  >;
}

export function createServiceRoleClient(key: string): ServiceRoleClient {
  const client = createService(key);
  return {
    async rpc(fn, args) {
      // The type already limits the name; this also stops a name built at run time.
      if (!isServiceRoleRpc(fn)) throw new Error("service-role function not allowed");
      const { data, error } = await client.rpc(fn, args);
      if (error) return { data: null, error: { code: error.code } };
      return { data, error: null };
    },
    async magicLinkToken(email) {
      const link = await client.auth.admin.generateLink({ type: "magiclink", email });
      const tokenHash = link.data.properties?.hashed_token;
      if (link.error || !tokenHash) return { tokenHash: null, error: { code: link.error?.code } };
      return { tokenHash, error: null };
    },
  };
}
