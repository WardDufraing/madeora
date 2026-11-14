import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { claimCelebration } from "@/ora/celebrations/server";
import { celebrationBodySchema, type OraCelebrationResponse } from "@/ora/celebrations/types";
import { resolveOraToolContext } from "@/ora/tools/server";

/**
 * Claims the celebration for chore points the person was just awarded (S47c). The de-duplication is
 * kept in the database (each ledger entry is celebrated once per person, across every tab and
 * device), so asking again from anywhere answers with no celebration.
 */

const MAX_BODY_BYTES = 256;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return json(refused.status, { error: refused.error });
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.error });
  const parsed = celebrationBodySchema.safeParse(body.body);
  if (!parsed.success) return json(400, { error: "invalid" });

  const resolved = await resolveOraToolContext(parsed.data.homeId);
  // A celebration is a courtesy, asked for in the background: signed out, not a member or unreadable
  // all answer "none" with 200, so a page the person lost access to logs no failed request.
  const none: OraCelebrationResponse = { celebration: null };
  if (resolved.status !== "ok") return json(200, none);

  const result = await claimCelebration(resolved.context);
  if (result.status !== "ok") return json(200, none);
  return json(200, {
    celebration: result.celebration,
    ...(result.deferred ? { deferred: true } : {}),
  } satisfies OraCelebrationResponse);
}
