import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { CreateHomeResponse, HomesErrorCode, HomesErrorResponse } from "@/homes/api";
import { createHomeSchema } from "@/homes/schema";

// A name, a timezone and a request id: a few hundred bytes at most.
const MAX_BODY_BYTES = 2048;

function json(status: number, body: CreateHomeResponse | HomesErrorResponse): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(status: number, error: HomesErrorCode, fields?: string[]): Response {
  return json(status, fields ? { error, fields } : { error });
}

/**
 * Creates a Home and makes the signed-in person its single Owner (S09; spec "Confirmed
 * Home-independent adult account onboarding": creating a Home is optional and explicit).
 *
 * Same request checks as every `/api/v1` mutation (CSRF, JSON only, size). The database function
 * `create_home` does the work with the person's own session, atomically, and returns the Home an
 * earlier attempt with the same request id already created instead of making a second one.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return failure(refused.status, refused.error);

  const identity = await getVerifiedIdentity();
  if (!identity) return failure(401, "unauthenticated");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return failure(body.status, body.error);
  const parsed = createHomeSchema.safeParse(body.body);
  if (!parsed.success) return failure(400, "invalid", refusedFields(parsed.error.issues));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_home", {
    p_name: parsed.data.name,
    p_timezone: parsed.data.timeZone,
    p_request_id: parsed.data.requestId,
  });
  // A check constraint refused a value the schema let through: the request was invalid.
  if (error?.code === "23514") return failure(400, "invalid");
  // The database did not accept the session as a confirmed account.
  if (error?.code === "42501") return failure(401, "unauthenticated");
  if (error) {
    // Privacy-safe: the error code only, no account id or values.
    console.error(JSON.stringify({ event: "homes.create_failed", code: error.code }));
    return failure(500, "failed");
  }
  return json(201, { home: { id: data } });
}
