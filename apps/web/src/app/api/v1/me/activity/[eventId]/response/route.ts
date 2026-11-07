import { z } from "zod";

import { databaseFailure, failure, json, readActivityMutation } from "@/activity/route-helpers";
import { signInResponseSchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";

interface ResponseRouteContext {
  readonly params: Promise<{ readonly eventId: string }>;
}

/**
 * "This was me" or "Secure my account" on one of the signed-in person's own sign-ins (S38).
 * Securing signs that session out when it is another, still-live session, and records a
 * suspicious-session report; the database checks the sign-in is the caller's own.
 */
export async function POST(request: Request, { params }: ResponseRouteContext): Promise<Response> {
  const input = await readActivityMutation(request, signInResponseSchema);
  if (!input.ok) return input.response;
  const { eventId } = await params;
  if (!z.uuid().safeParse(eventId).success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("respond_to_sign_in", {
    p_event_id: eventId,
    p_response: input.data.response,
  });
  if (error) return databaseFailure("activity.respond_failed", error);
  return json(200, { result: data });
}
