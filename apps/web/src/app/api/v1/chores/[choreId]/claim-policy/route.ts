import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getChoreClaimPolicy } from "@/chores/data";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { claimPolicySchema } from "@/chores/schema";

const impactSchema = z.object({
  expireNow: z.int(),
  releaseNow: z.int(),
  claimedIneligible: z.int(),
});

interface ChoreRouteContext {
  readonly params: Promise<{ readonly choreId: string }>;
}

/** A chore's claim policies (S21); the selected members only for chore managers. */
export async function GET(_request: Request, { params }: ChoreRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).choreId);
  if (!id) return failure(404, "not-found");
  const policy = await getChoreClaimPolicy(id);
  if (policy.status === "not-found") return failure(404, "not-found");
  if (policy.status === "unavailable") return failure(500, "failed");
  return json(200, { policy: policy.value });
}

/**
 * Sets who may claim a chore, whether its unclaimed occurrences close after their week and its
 * automatic release (S21, chore managers), or previews that with `dryRun`. A change that closes or
 * releases something at once answers `409 needs-confirmation` with the impact unless `confirm`.
 */
export async function PUT(request: Request, { params }: ChoreRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, claimPolicySchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).choreId);
  if (!id) return failure(404, "not-found");
  const policy = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_chore_claim_policy", {
    p_chore_id: id,
    p_expected_revision: policy.expectedRevision,
    p_mode: policy.mode,
    p_member_ids: policy.memberIds,
    p_expiry: policy.expiry,
    ...(policy.autoReleaseHours !== null ? { p_auto_release_hours: policy.autoReleaseHours } : {}),
    p_dry_run: policy.dryRun,
    p_confirm: policy.confirm,
  });
  if (error) return databaseFailure("chores.claim_policy_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  const impact = impactSchema.safeParse(row ? nullable(row.impact) : null);
  return outcomeAnswer(
    "chores.claim_policy_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: impact.data ?? null, revision },
    { revision, impact: impact.data ?? undefined },
  );
}
