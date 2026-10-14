import { getPublicEnv } from "@madeora/config/env/public";

import { getVerifiedIdentity } from "@/auth/identity";
import { isSameOriginRequest } from "@/auth/same-origin";
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

/** The body as text, or `null` once it grows past `limit` bytes (read no further than that). */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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
  if (!isSameOriginRequest(request.headers, getPublicEnv().NEXT_PUBLIC_APP_URL)) {
    return failure(403, "forbidden");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(?:;|$)/i.test(contentType)) {
    return failure(415, "unsupported-media-type");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^\d+$/.test(declaredLength)) return failure(400, "invalid");
  if (Number(declaredLength ?? 0) > MAX_BODY_BYTES) return failure(413, "too-large");

  const identity = await getVerifiedIdentity();
  if (!identity) return failure(401, "unauthenticated");

  const text = await readLimited(request, MAX_BODY_BYTES);
  if (text === null) return failure(413, "too-large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure(400, "invalid");
  }
  const parsed = preferencesPatchSchema.safeParse(body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    return failure(400, "invalid", fields.filter(Boolean));
  }

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
