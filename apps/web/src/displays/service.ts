import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { householdClientKey, householdService, sessionIdOf } from "@/child-sign-in/service";

import {
  clearPairingCookie,
  currentPairingSecret,
  newPairingSecret,
  pairingCodeHash,
  pairingCodeOf,
  setPairingCookie,
  sha256Hex,
} from "./pairing-secret";

/**
 * The tablet's side of Household Display pairing (S43, architecture.md §33). Runs only for a
 * browser without any session (the route checks). The web server talks to the database as the
 * service role, because the tablet has no account yet; the database decides everything about the
 * request from the SHA-256 of the tablet's secret. Once a manager approved the request, the server
 * has Supabase Auth issue an ordinary session for the display's internal alias on this response and
 * registers it, which is what makes the display's token usable at all. Nothing secret is logged:
 * events carry a name and, at most, a database error code.
 */

export type PairingScreen =
  | { readonly kind: "pending"; readonly code: string; readonly expiresAt: string }
  | { readonly kind: "expired" }
  | { readonly kind: "paired" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "unavailable" };

function log(event: string, code?: string): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

const CREATE_TRIES = 3;

/**
 * Where this tablet's pairing stands, after: throwing its code away (`renew`), resuming it,
 * finishing an approval (`paired`: the display session cookies are now on this response), or
 * starting a new request when it has none.
 */
export async function resumePairing(renew: boolean, userAgent: string): Promise<PairingScreen> {
  const client = householdService();
  if (!client) return { kind: "unavailable" };

  let secret = await currentPairingSecret();
  if (secret && renew) {
    const cancelled = await client.rpc("display_pairing_cancel", {
      p_secret_hash: sha256Hex(secret),
    });
    if (cancelled.error) {
      log("display_pairing.cancel_failed", cancelled.error.code);
      return { kind: "unavailable" };
    }
    secret = null;
  }
  if (secret) {
    const { data, error } = await client.rpc("display_pairing_status", {
      p_secret_hash: sha256Hex(secret),
    });
    if (error) {
      log("display_pairing.status_failed", error.code);
      return { kind: "unavailable" };
    }
    const row = data[0];
    if (row?.status === "pending" && row.expires_at) {
      return { kind: "pending", code: pairingCodeOf(secret), expiresAt: row.expires_at };
    }
    if (row?.status === "approved") return claim(secret);
    if (row?.status === "expired") return { kind: "expired" };
    // 'unknown': no request behind this cookie any more; start a new one.
  }
  return startPairing(userAgent);
}

async function startPairing(userAgent: string): Promise<PairingScreen> {
  const client = householdService();
  const clientKey = await householdClientKey();
  if (!client || !clientKey) return { kind: "unavailable" };
  for (let attempt = 0; attempt < CREATE_TRIES; attempt += 1) {
    const secret = newPairingSecret();
    const code = pairingCodeOf(secret);
    const { data, error } = await client.rpc("display_pairing_start", {
      p_secret_hash: sha256Hex(secret),
      p_code_hash: pairingCodeHash(code),
      p_client_key: clientKey,
      p_user_agent: userAgent.slice(0, 512),
    });
    if (error) {
      log("display_pairing.start_failed", error.code);
      return { kind: "unavailable" };
    }
    const row = data[0];
    if (row?.outcome === "rate_limited") return { kind: "rate-limited" };
    if (row?.outcome === "created" && row.expires_at) {
      await setPairingCookie(secret);
      return { kind: "pending", code, expiresAt: row.expires_at };
    }
    // 'collision': another tablet's pending code is the same; try a new secret.
  }
  log("display_pairing.no_free_code");
  return { kind: "unavailable" };
}

/** Turns an approval into this tablet's display session (approval → session → registration). */
async function claim(secret: string): Promise<PairingScreen> {
  const client = householdService();
  if (!client) return { kind: "unavailable" };
  const secretHash = sha256Hex(secret);
  const claimed = await client.rpc("display_pairing_claim", { p_secret_hash: secretHash });
  if (claimed.error) {
    log("display_pairing.claim_failed", claimed.error.code);
    return { kind: "unavailable" };
  }
  const row = claimed.data[0];
  if (row?.outcome !== "ready" || !row.alias_email) return { kind: "expired" };

  const link = await client.auth.admin.generateLink({ type: "magiclink", email: row.alias_email });
  const tokenHash = link.data.properties?.hashed_token;
  if (link.error || !tokenHash) {
    log("display_pairing.link_failed", link.error?.code);
    return { kind: "unavailable" };
  }
  // Sets the session cookies on this response. The route made sure no session was here before.
  const supabase = await createSupabaseServerClient();
  const otp = await supabase.auth.verifyOtp({ type: "email", token_hash: tokenHash });
  const session = otp.data.session;
  if (otp.error || !session) {
    log("display_pairing.session_failed", otp.error?.code);
    return { kind: "unavailable" };
  }
  const sessionId = sessionIdOf(session.access_token);
  const completed = sessionId
    ? await client.rpc("display_pairing_complete", {
        p_secret_hash: secretHash,
        p_session_id: sessionId,
      })
    : null;
  if (!completed || completed.error || completed.data !== "registered") {
    log("display_pairing.register_failed", completed?.error?.code);
    // The database would refuse the unregistered session anyway; end it so nothing lingers. The
    // tablet can retry within the claim window.
    await supabase.auth.signOut({ scope: "local" });
    return { kind: "unavailable" };
  }
  await clearPairingCookie();
  return { kind: "paired" };
}
