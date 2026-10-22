import "server-only";

import { failure, json, nullable, outcomeAnswer } from "@/chores/route-helpers";

/**
 * The HTTP answer of a points or rewards change (S23). Success outcomes answer 200 (`created` 201)
 * with `body`; the points refusals have their own codes; anything else is a chore outcome
 * (`conflict`, `not_found`, `not_permitted`, ...). Here `ended` and `archived` describe a reward.
 */
export function pointsAnswer(
  event: string,
  outcome: string | undefined,
  body: object,
  details: { readonly revision?: number | null; readonly nextEligibleOn?: string | null } = {},
): Response {
  const revision = details.revision ?? undefined;
  const withRevision = revision === undefined ? {} : { revision };
  switch (outcome) {
    case "posted":
    case "reversed":
    case "redeemed":
    case "resolved":
      return json(200, body);
    case "insufficient_points":
      return json(409, { error: "insufficient-points", ...body });
    case "cost_changed":
      return json(409, { error: "cost-changed", ...body });
    case "member_limit":
      return json(409, {
        error: "member-limit",
        nextEligibleOn: details.nextEligibleOn ?? null,
      });
    case "sold_out":
      return failure(409, "sold-out");
    case "not_started":
      return failure(409, "reward-not-started");
    case "ended":
      return failure(409, "reward-ended");
    case "disabled":
      return failure(409, "reward-disabled");
    case "archived":
      return failure(409, "reward-archived", withRevision);
    case "own_request":
      return failure(403, "own-request");
    case "reward_unavailable":
      return json(409, { error: "reward-unavailable", ...body, ...withRevision });
    case "requester_unavailable":
      return failure(409, "requester-unavailable", withRevision);
    case "already_reversed":
      return failure(409, "already-reversed");
    case "not_reversible":
      return failure(409, "not-reversible");
    case "already_resolved":
      return failure(409, "already-resolved", withRevision);
    case "not_unable":
      return failure(409, "not-unable", withRevision);
    case "not_redeemed":
      return failure(409, "not-redeemed", withRevision);
    case "not_replacement":
      return failure(409, "not-replacement", withRevision);
    case "member_unavailable":
      return failure(409, "member-unavailable");
    case "account_unavailable":
      return failure(409, "account-unavailable", withRevision);
    case "invalid_responsible":
      return failure(400, "invalid", { fields: ["responsible"] });
    default:
      return outcomeAnswer(event, outcome, body, { revision: nullable(details.revision ?? null) });
  }
}
