import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, json, readPrivacyMutation } from "@/privacy/route-helpers";
import { homeExportAccessSchema } from "@/privacy/schema";

interface HomeRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Grants or revokes the Home permission exportHomeData for one Administrator or Member (S39 part
 * 2). Only the Owner, never for the Owner. Works at once (a revoke ends that person's Home
 * exports) and is audited.
 */
export async function PUT(request: Request, { params }: HomeRouteContext): Promise<Response> {
  const input = await readPrivacyMutation(request, homeExportAccessSchema);
  if (!input.ok) return input.response;
  const { homeId } = await params;
  if (!z.uuid().safeParse(homeId).success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_home_export_access", {
    p_home_id: homeId,
    p_membership_id: input.data.membershipId,
    p_granted: input.data.granted,
  });
  if (error) {
    // A Home the person is not in answers like one that does not exist.
    if (error.code === "42501") return failure(404, "not-found");
    return databaseFailure("privacy.home_export_access_failed", error);
  }
  switch (data) {
    case "ok":
    case "unchanged":
      return json(200, { outcome: data });
    case "not_permitted":
      return failure(403, "not-permitted");
    case "not_found":
      return failure(404, "not-found");
    default:
      return failure(500, "failed");
  }
}
