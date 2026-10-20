import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { BulkOutcome, BulkResult } from "@/tasks/api";
import { logTasks } from "@/tasks/log";
import {
  databaseFailure,
  json,
  nullable,
  readTaskMutation,
  TASK_BODY_BYTES,
} from "@/tasks/route-helpers";
import { bulkSchema } from "@/tasks/schema";

const outcomes: readonly BulkOutcome[] = [
  "changed",
  "will_change",
  "unchanged",
  "conflict",
  "not_found",
  "not_permitted",
  "list_unavailable",
  "invalid_label",
  "too_many_labels",
  "failed",
];

/**
 * One basic action on selected tasks of one context (S19b; spec "basic bulk task actions"):
 * complete, priority, labels or move. `dryRun` previews it with each task's warnings (unfinished
 * subtasks, recurring, shared). Each task succeeds or fails on its own, with the single action's
 * rules; the answer lists every task's result, so a retry of the same request changes nothing twice.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTaskMutation(request, bulkSchema, TASK_BODY_BYTES);
  if (!input.ok) return input.response;
  const bulk = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("bulk_update_tasks", {
    p_task_ids: bulk.taskIds,
    p_action: bulk.action,
    // A preview without revisions checks none; the change itself always has them (the schema).
    p_expected_revisions: bulk.expectedRevisions ?? {},
    p_dry_run: bulk.dryRun,
    ...(bulk.homeId ? { p_home_id: bulk.homeId } : {}),
    ...(bulk.action === "priority" && bulk.priority !== null ? { p_priority: bulk.priority } : {}),
    ...(bulk.action === "labels"
      ? { p_label_mode: bulk.labelMode, p_label_ids: bulk.labelIds }
      : {}),
    ...(bulk.action === "move" ? { p_list_id: bulk.listId } : {}),
  });
  if (error) return databaseFailure("tasks.bulk_failed", error);
  const results: BulkResult[] = data.map((row) => {
    const outcome = outcomes.find((known) => known === row.outcome);
    if (!outcome) logTasks("tasks.bulk_failed", "unexpected_outcome");
    return {
      taskId: row.task_id,
      outcome: outcome ?? "failed",
      revision: nullable(row.revision),
      openSubtasks: nullable(row.open_subtasks),
      recurring: nullable(row.recurring),
      shared: nullable(row.shared),
    };
  });
  return json(200, { action: bulk.action, dryRun: bulk.dryRun, results });
}
