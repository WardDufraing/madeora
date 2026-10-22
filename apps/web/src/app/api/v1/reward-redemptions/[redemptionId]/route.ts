import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  pathId,
  readChoreMutation,
  requireReader,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { getRedemption } from "@/points/data";
import { pointsAnswer } from "@/points/route-helpers";
import { redemptionChangeSchema, type RedemptionChangeInput } from "@/points/schema";

interface RedemptionRouteContext {
  readonly params: Promise<{ readonly redemptionId: string }>;
}

/** One redemption with its history (S23): its requester, rewards managers, reviewers while pending. */
export async function GET(
  _request: Request,
  { params }: RedemptionRouteContext,
): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).redemptionId);
  if (!id) return failure(404, "not-found");
  const redemption = await getRedemption(id);
  if (redemption.status === "not-found") return failure(404, "not-found");
  if (redemption.status === "unavailable") return failure(500, "failed");
  return json(200, redemption.value);
}

async function send(id: string, change: RedemptionChangeInput) {
  const supabase = await createSupabaseServerClient();
  switch (change.action) {
    case "approve":
    case "reject": {
      const { data, error } = await supabase.rpc("review_reward_redemption", {
        p_redemption_id: id,
        p_expected_revision: change.expectedRevision,
        p_decision: change.action === "approve" ? "approve" : "reject",
        ...(change.action === "reject" && change.reason !== null
          ? { p_reason: change.reason }
          : {}),
        ...(change.action === "approve" ? { p_confirm: change.confirm } : {}),
      });
      const row = data?.[0];
      return {
        error,
        outcome: row?.outcome,
        detail: row ? nullable(row.detail) : null,
        revision: row ? nullable(row.revision) : null,
      };
    }
    case "cancel": {
      const { data, error } = await supabase.rpc("cancel_reward_redemption", {
        p_redemption_id: id,
        p_expected_revision: change.expectedRevision,
        ...(change.reason !== null ? { p_reason: change.reason } : {}),
      });
      const row = data?.[0];
      return {
        error,
        outcome: row?.outcome,
        detail: null,
        revision: row ? nullable(row.revision) : null,
      };
    }
    case "fulfillment": {
      const { data, error } = await supabase.rpc("set_reward_fulfillment", {
        p_redemption_id: id,
        p_expected_revision: change.expectedRevision,
        p_state: change.state,
        ...(change.note !== null ? { p_note: change.note } : {}),
      });
      const row = data?.[0];
      return {
        error,
        outcome: row?.outcome,
        detail: null,
        revision: row ? nullable(row.revision) : null,
      };
    }
    case "resolve": {
      const { data, error } = await supabase.rpc("resolve_reward_redemption", {
        p_redemption_id: id,
        p_expected_revision: change.expectedRevision,
        p_resolution: change.resolution,
        p_dry_run: change.dryRun,
        ...(change.note !== null ? { p_note: change.note } : {}),
        ...(change.replacement !== null ? { p_replacement: change.replacement } : {}),
        ...(change.responsible !== null ? { p_responsible: change.responsible } : {}),
      });
      const row = data?.[0];
      return {
        error,
        outcome: row?.outcome,
        detail: row ? nullable(row.impact) : null,
        revision: row ? nullable(row.revision) : null,
      };
    }
    case "replacement": {
      const { data, error } = await supabase.rpc("set_replacement_outcome", {
        p_redemption_id: id,
        p_expected_revision: change.expectedRevision,
        p_state: change.state,
        ...(change.note !== null ? { p_note: change.note } : {}),
      });
      const row = data?.[0];
      return {
        error,
        outcome: row?.outcome,
        detail: null,
        revision: row ? nullable(row.revision) : null,
      };
    }
  }
}

/**
 * Acts on a redemption (S23): `approve` or `reject` someone else's pending request (reviewers, never
 * the requester), `cancel` a pending one (the requester, or a rewards manager with a reason),
 * `fulfillment` (fulfilled, unable, or a correction with a reason), `resolve` an unable-to-fulfill
 * case (refund once, or an agreed replacement; `dryRun`), and a replacement's outcome.
 */
export async function PATCH(
  request: Request,
  { params }: RedemptionRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, redemptionChangeSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = pathId((await params).redemptionId);
  if (!id) return failure(404, "not-found");
  const result = await send(id, input.data);
  if (result.error) return databaseFailure("rewards.redemption_change_failed", result.error);
  return pointsAnswer(
    "rewards.redemption_change_failed",
    result.outcome,
    { outcome: result.outcome, detail: result.detail, revision: result.revision },
    { revision: result.revision },
  );
}
