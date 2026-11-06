import { getPublicEnv } from "@madeora/config/env/public";
import { cookies } from "next/headers";

import { checkJsonMutation } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { describeDevice } from "@/auth/sessions";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { newTrustToken, trustCookieName, trustCookieOptions } from "@/auth/trusted-device";

type TrustErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "invalid"
  | "unauthenticated"
  | "second-factor-required"
  | "failed";

function failure(status: number, error: TrustErrorCode): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Trusts this browser for 30 days (S37), right after the second factor. The token is made here
 * and only ever lives in an httpOnly cookie; the database stores its hash and refuses unless this
 * session verified an authenticator code in the last 10 minutes.
 *
 * A cookie-authenticated mutation: cross-site requests are refused (CSRF, architecture.md §7) and
 * only a JSON body (empty object) is accepted.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, 64);
  if (refused) return failure(refused.status, refused.error);

  const identity = await getVerifiedIdentity();
  if (!identity) return failure(401, "unauthenticated");

  const token = newTrustToken();
  const device = describeDevice(request.headers.get("user-agent"));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("trust_this_device", {
    p_token: token,
    p_kind: device.kind,
    p_browser: device.browser,
    p_platform: device.platform,
  });
  if (error?.code === "42501") return failure(403, "second-factor-required");
  if (error) {
    console.error(JSON.stringify({ event: "trusted_device.failed", code: error.code }));
    return failure(500, "failed");
  }

  (await cookies()).set(
    trustCookieName(identity.userId),
    token,
    trustCookieOptions(getPublicEnv().NEXT_PUBLIC_APP_URL, new Date(data)),
  );
  return Response.json(
    { expiresAt: data },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
