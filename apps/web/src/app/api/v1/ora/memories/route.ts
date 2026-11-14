import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { prepareAction } from "@/ora/actions/server";
import { deleteMemory, saveMemory } from "@/ora/memories/server";
import { deleteMemorySchema, saveMemorySchema } from "@/ora/memories/types";
import { findInputTool } from "@/ora/tools/registry";
import { resolveOraToolContext, type OraToolContextResult } from "@/ora/tools/server";

/**
 * What Ora remembers (S47b): remember a list choice (only a list the person may add to right now, in
 * a place they belong to, and only while the matching action is theirs to use) and forget one. Both
 * are the person's own; nobody sets or reads another member's memories.
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

export async function POST(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return json(refused.status, { error: refused.error });
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.error });
  const parsed = saveMemorySchema.safeParse(body.body);
  if (!parsed.success) return json(400, { error: "invalid" });
  const { homeId, action, listId } = parsed.data;

  const resolved = await resolveOraToolContext(homeId);
  if (resolved.status !== "ok") return refusal(resolved);
  const { context } = resolved;
  if (!findInputTool(context, action)) return json(403, { error: "forbidden" });

  const prepared = await prepareAction(context, action);
  if (prepared.status !== "ok") return json(503, { error: "unavailable" });
  const result = await saveMemory(context, action, listId, prepared.preview.destinations);
  if (result === "forbidden") return json(403, { error: "forbidden" });
  if (result === "not-found") return json(404, { error: "not-found" });
  if (result === "failed") return json(500, { error: "failed" });
  return json(200, { ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return json(refused.status, { error: refused.error });
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.error });
  const parsed = deleteMemorySchema.safeParse(body.body);
  if (!parsed.success) return json(400, { error: "invalid" });

  const identity = await getVerifiedIdentity();
  if (!identity) return json(401, { error: "unauthenticated" });
  const result = await deleteMemory(identity.userId, parsed.data.homeId, parsed.data.key);
  if (result !== "ok") return json(500, { error: "failed" });
  return json(200, { ok: true });
}
