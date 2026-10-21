import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { AttachmentRemoveResponse } from "@/tasks/api";
import { readImpact } from "@/tasks/attachment-data";
import { attachmentRemoveSchema } from "@/tasks/attachment-policy";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
} from "@/tasks/route-helpers";

interface AttachmentRouteContext {
  readonly params: Promise<{ readonly attachmentId: string }>;
}

/**
 * Removes an attachment into the trash of its task's context (S19c, the S16 rules): `{ scope,
 * dryRun }`. `this` removes it from this task; `following` / `series` on an attachment that came
 * from the series also stops new occurrences getting it and removes it from the open occurrences in
 * scope that were not changed on their own (completed ones keep theirs). `dryRun` answers the
 * impact only. The database checks the person's rights again.
 */
export async function DELETE(
  request: Request,
  { params }: AttachmentRouteContext,
): Promise<Response> {
  const input = await readTaskMutation(request, attachmentRemoveSchema);
  if (!input.ok) return input.response;
  const attachmentId = z.uuid().safeParse((await params).attachmentId);
  if (!attachmentId.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_task_attachment", {
    p_attachment_id: attachmentId.data,
    p_scope: input.data.scope,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("tasks.attachment_remove_failed", error);
  const row = data[0];
  if (row?.outcome === "removed" || row?.outcome === "preview") {
    const body: AttachmentRemoveResponse = {
      entryId: row.outcome === "removed" ? row.entry_id : null,
      impact: readImpact(row.impact),
    };
    return json(200, body);
  }
  return outcomeAnswer("tasks.attachment_remove", row?.outcome, {});
}
