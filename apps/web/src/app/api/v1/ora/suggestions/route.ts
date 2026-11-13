import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { dismissSuggestion, loadSuggestions } from "@/ora/suggestions/server";
import { dismissSuggestionSchema, type OraSuggestionsResponse } from "@/ora/suggestions/types";
import { resolveOraToolContext, type OraToolContextResult } from "@/ora/tools/server";

/**
 * Ora's suggestions (S47): what Ora offers the signed-in person here, and dismissing one. The person
 * and their membership are resolved from the database on every call; the Home id only names which
 * Home to look up. A Home the person does not belong to answers 403.
 */

const MAX_BODY_BYTES = 1024;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function refusal(result: Exclude<OraToolContextResult, { status: "ok" }>): Response {
  if (result.status === "unauthenticated") return json(401, { error: "unauthenticated" });
  if (result.status === "forbidden") return json(403, { error: "forbidden" });
  return json(503, { error: "unavailable" });
}

export async function GET(request: Request): Promise<Response> {
  const resolved = await resolveOraToolContext(new URL(request.url).searchParams.get("homeId"));
  if (resolved.status !== "ok") return refusal(resolved);
  const loaded = await loadSuggestions(resolved.context);
  if (loaded.status !== "ok") return json(503, { error: "unavailable" });
  return json(200, { suggestions: loaded.suggestions } satisfies OraSuggestionsResponse);
}

/** Dismisses one suggestion for the person in this place. */
export async function POST(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return json(refused.status, { error: refused.error });
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.error });
  const parsed = dismissSuggestionSchema.safeParse(body.body);
  if (!parsed.success) return json(400, { error: "invalid" });

  const resolved = await resolveOraToolContext(parsed.data.homeId);
  if (resolved.status !== "ok") return refusal(resolved);
  const result = await dismissSuggestion(resolved.context, parsed.data.kind, parsed.data.situation);
  if (result === "forbidden") return json(403, { error: "forbidden" });
  if (result === "failed") return json(500, { error: "failed" });
  return json(200, { ok: true });
}
