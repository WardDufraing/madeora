import { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { clearHistory, loadHistory, recordHistory } from "@/ora/history/server";
import { recordHistorySchema, type OraHistoryResponse } from "@/ora/history/types";
import { resolveOraToolContext, type OraToolContextResult } from "@/ora/tools/server";

/**
 * Ora's seven-day history (S47b): read this place's lines, add one, clear all of the person's own.
 * The person and their membership are resolved from the database on every call.
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
  const loaded = await loadHistory(resolved.context);
  if (loaded.status !== "ok") return json(503, { error: "unavailable" });
  return json(200, { entries: loaded.entries } satisfies OraHistoryResponse);
}

export async function POST(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return json(refused.status, { error: refused.error });
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.error });
  const parsed = recordHistorySchema.safeParse(body.body);
  if (!parsed.success) return json(400, { error: "invalid" });

  const resolved = await resolveOraToolContext(parsed.data.homeId);
  if (resolved.status !== "ok") return refusal(resolved);
  const result = await recordHistory(resolved.context, parsed.data.kind, parsed.data.label);
  if (result === "forbidden") return json(403, { error: "forbidden" });
  if (result === "failed") return json(500, { error: "failed" });
  return json(201, { ok: true });
}

/** Clear recent interactions: the person's own lines, everywhere. */
export async function DELETE(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return json(refused.status, { error: refused.error });
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.error });
  if (!z.strictObject({}).safeParse(body.body).success) return json(400, { error: "invalid" });

  const identity = await getVerifiedIdentity();
  if (!identity) return json(401, { error: "unauthenticated" });
  const result = await clearHistory(identity.userId);
  if (result !== "ok") return json(500, { error: "failed" });
  return json(200, { ok: true });
}
