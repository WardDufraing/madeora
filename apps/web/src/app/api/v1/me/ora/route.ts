import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { oraPatchSchema } from "@/ora/settings";

// A settings change is a few hundred bytes; anything far larger is not one.
const MAX_BODY_BYTES = 1024;

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Changes the signed-in person's own Ora settings (S45): on/off, motion mode, the introduction
 * state and the colour in Personal space or in one Home. A cookie-authenticated mutation, so
 * cross-site requests and non-JSON bodies are refused. Every row is written with the person's own
 * session: RLS limits it to their own row, and a Home colour only while they are a member there
 * (nobody sets another member's Ora).
 */
export async function PATCH(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return failure(refused.status, refused.error);

  const identity = await getVerifiedIdentity();
  if (!identity) return failure(401, "unauthenticated");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return failure(body.status, body.error);
  const parsed = oraPatchSchema.safeParse(body.body);
  if (!parsed.success) return failure(400, "invalid");
  const patch = parsed.data;

  const supabase = await createSupabaseServerClient();

  const personal = {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.motion !== undefined ? { motion: patch.motion } : {}),
    ...(patch.intro !== undefined ? { intro: patch.intro } : {}),
    ...(patch.teasersMuted !== undefined ? { teasers_muted: patch.teasersMuted } : {}),
    ...(patch.frequency !== undefined ? { frequency: patch.frequency } : {}),
    ...(patch.categories?.reminders !== undefined
      ? { cat_reminders: patch.categories.reminders }
      : {}),
    ...(patch.categories?.suggestions !== undefined
      ? { cat_suggestions: patch.categories.suggestions }
      : {}),
    ...(patch.categories?.celebrations !== undefined
      ? { cat_celebrations: patch.categories.celebrations }
      : {}),
    ...(patch.quietHours !== undefined
      ? {
          quiet_start: patch.quietHours?.start ?? null,
          quiet_end: patch.quietHours?.end ?? null,
        }
      : {}),
    ...(patch.personalPalette !== undefined ? { personal_palette: patch.personalPalette } : {}),
  };
  if (Object.keys(personal).length > 0) {
    const { error } = await supabase
      .from("ora_preferences")
      .upsert({ user_id: identity.userId, ...personal }, { onConflict: "user_id" });
    if (error?.code === "23514") return failure(400, "invalid");
    if (error) {
      // Privacy-safe: the error code only, no account id or values.
      console.error(JSON.stringify({ event: "ora.settings_write_failed", code: error.code }));
      return failure(500, "failed");
    }
  }

  if (patch.homePalette) {
    const { error } = await supabase.from("ora_home_palettes").upsert(
      {
        home_id: patch.homePalette.homeId,
        user_id: identity.userId,
        palette: patch.homePalette.palette,
      },
      { onConflict: "home_id,user_id" },
    );
    // RLS refuses a Home the person is not a member of; say so without describing the Home.
    if (error?.code === "42501") return failure(403, "forbidden");
    if (error?.code === "23514") return failure(400, "invalid");
    if (error) {
      console.error(JSON.stringify({ event: "ora.settings_write_failed", code: error.code }));
      return failure(500, "failed");
    }
  }

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
