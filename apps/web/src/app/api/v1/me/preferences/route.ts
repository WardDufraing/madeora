import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { PREFERENCE_COLUMNS, patchToColumns, preferencesFromRow } from "@/preferences/account";
import type {
  PreferencesErrorCode,
  PreferencesErrorResponse,
  PreferencesResponse,
} from "@/preferences/api";
import { preferencesPatchSchema } from "@/preferences/schema";

// A preferences change is a few hundred bytes; anything far larger is not one.
const MAX_BODY_BYTES = 4096;

function json(status: number, body: PreferencesResponse | PreferencesErrorResponse): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(status: number, error: PreferencesErrorCode, fields?: string[]): Response {
  return json(status, fields ? { error, fields } : { error });
}

/**
 * Changes some of the signed-in account's global preferences (S07) and returns all of them.
 *
 * A cookie-authenticated mutation: cross-site requests are refused (CSRF, architecture.md §7), and
 * only JSON is accepted, which a cross-site form cannot send. The identity is confirmed with
 * Supabase Auth, the body validated with the same schema the forms use, and the row written with
 * the person's own session, so RLS limits the write to their own row (architecture.md §5, §6).
 */
export async function PATCH(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return failure(refused.status, refused.error);

  const identity = await getVerifiedIdentity();
  if (!identity) return failure(401, "unauthenticated");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return failure(body.status, body.error);
  const parsed = preferencesPatchSchema.safeParse(body.body);
  if (!parsed.success) return failure(400, "invalid", refusedFields(parsed.error.issues));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("user_preferences")
    .upsert({ user_id: identity.userId, ...patchToColumns(parsed.data) }, { onConflict: "user_id" })
    .select(PREFERENCE_COLUMNS)
    .single();
  // A check constraint refused a value the schema let through: the request was invalid.
  if (error?.code === "23514") return failure(400, "invalid");
  if (error) {
    // Privacy-safe: the error code only, no account id or values.
    console.error(JSON.stringify({ event: "preferences.write_failed", code: error.code }));
    return failure(500, "failed");
  }
  return json(200, { preferences: preferencesFromRow(data) });
}
