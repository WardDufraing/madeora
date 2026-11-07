import { databaseFailure, failure, json, readActivityMutation } from "@/activity/route-helpers";
import { securityReportRequestSchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/**
 * Requests a security report of the signed-in person's own account (S38). The database requires
 * this browser session's fresh 'security_report' permission (re-authentication just before),
 * checks the range against the retention period and allows 3 requests a day.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readActivityMutation(request, securityReportRequestSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_security_report", {
    p_from: input.data.from,
    p_to: input.data.to,
    p_timezone: input.data.timeZone,
  });
  if (error) return databaseFailure("activity.report_request_failed", error);
  if (typeof data !== "string") return failure(500, "failed");
  return json(201, { id: data });
}
