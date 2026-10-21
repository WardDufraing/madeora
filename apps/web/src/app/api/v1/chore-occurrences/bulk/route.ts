import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { BulkOutcome, BulkResponse } from "@/chores/api";
import { logChores } from "@/chores/log";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  json,
  nullable,
  readChoreMutation,
} from "@/chores/route-helpers";
import { bulkSchema } from "@/chores/schema";

const bulkOutcomes: readonly BulkOutcome[] = [
  "preview",
  "saved",
  "skipped",
  "not_found",
  "not_permitted",
  "conflict",
  "occurrence_closed",
  "pending_approval",
  "invalid_assignee",
  "needs_confirmation",
  "failed",
];

/**
 * Reassigns, skips or moves the due date of selected occurrences of one Home (S20, chore managers;
 * spec "Confirmed limited bulk chore occurrence management"), or previews it (`dryRun`). Each
 * occurrence is checked and changed on its own with the revision the manager saw, so the answer is
 * always 200 with one result per item, in the order given: some may apply while others are refused
 * with their reason. Only the selected occurrences change, never a series or its rotation.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, bulkSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const bulk = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("bulk_chore_occurrences", {
    p_home_id: bulk.homeId,
    p_action: bulk.action,
    p_items: bulk.items,
    p_dry_run: bulk.dryRun,
    ...(bulk.member === null ? {} : { p_member: bulk.member }),
    ...(bulk.dueDate === null ? {} : { p_due_date: bulk.dueDate }),
    ...(bulk.reason === null ? {} : { p_reason: bulk.reason }),
  });
  if (error) return databaseFailure("chores.bulk_failed", error);
  const results = data.map((row) => {
    const known = bulkOutcomes.includes(row.outcome as BulkOutcome);
    if (!known) logChores("chores.bulk_failed", "unexpected_outcome");
    return {
      occurrenceId: row.occurrence_id,
      outcome: known ? (row.outcome as BulkOutcome) : "failed",
      title: nullable(row.title),
      dueBefore: nullable(row.due_before),
      dueAfter: nullable(row.due_after),
      assigneesBefore: nullable(row.assignees_before),
      assigneesAfter: nullable(row.assignees_after),
      revision: nullable(row.revision),
    };
  });
  return json(200, {
    action: bulk.action,
    dryRun: bulk.dryRun,
    results,
  } satisfies BulkResponse);
}
