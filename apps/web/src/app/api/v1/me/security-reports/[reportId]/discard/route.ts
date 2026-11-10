import { z } from "zod";

import { databaseFailure, failure, json, readActivityMutation } from "@/activity/route-helpers";
import { createSupabaseServerClient } from "@/auth/supabase-server";

const emptyBody = z.strictObject({});

interface DiscardRouteContext {
  readonly params: Promise<{ readonly reportId: string }>;
}

/** Discards one of the signed-in person's own reports before it expires (S38). */
export async function POST(request: Request, { params }: DiscardRouteContext): Promise<Response> {
  const input = await readActivityMutation(request, emptyBody);
  if (!input.ok) return input.response;
  const { reportId } = await params;
  if (!z.uuid().safeParse(reportId).success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("discard_security_report", { p_report_id: reportId });
  if (error) return databaseFailure("activity.report_discard_failed", error);
  return json(200, { discarded: data });
}
