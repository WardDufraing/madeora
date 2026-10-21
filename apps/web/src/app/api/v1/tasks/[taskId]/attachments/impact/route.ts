import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readImpact } from "@/tasks/attachment-data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  requireReader,
} from "@/tasks/route-helpers";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

const querySchema = z.object({
  scope: z.enum(["following", "series"]),
  attachmentId: z.uuid().optional(),
});

/**
 * What adding a file to (or, with `attachmentId`, removing one from) following or all occurrences
 * would change (S19c), for the scope dialog before anything is uploaded or removed.
 */
export async function GET(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const taskId = z.uuid().safeParse((await params).taskId);
  if (!taskId.success) return failure(404, "not-found");
  const search = new URL(request.url).searchParams;
  const query = querySchema.safeParse({
    scope: search.get("scope") ?? undefined,
    attachmentId: search.get("attachmentId") ?? undefined,
  });
  if (!query.success) return failure(400, "invalid");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("task_attachment_scope_impact", {
    p_task_id: taskId.data,
    p_scope: query.data.scope,
    ...(query.data.attachmentId ? { p_attachment_id: query.data.attachmentId } : {}),
  });
  if (error) return databaseFailure("tasks.attachment_impact_failed", error);
  const row = data[0];
  if (row?.outcome === "preview") {
    const impact = readImpact(row.impact);
    return impact ? json(200, { impact }) : failure(500, "failed");
  }
  return outcomeAnswer("tasks.attachment_impact", row?.outcome, {});
}
