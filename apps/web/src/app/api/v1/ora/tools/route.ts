import { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { availableTools, runTool } from "@/ora/tools/registry";
import { resolveOraToolContext, type OraToolContextResult } from "@/ora/tools/server";
import type { OraToolRunResponse, OraToolsErrorCode, OraToolsResponse } from "@/ora/tools/types";

/**
 * Ora's tools (S45): what the signed-in person may use in one place, and running one. Both
 * resolve the person and their membership from the database on every call and ask the permission
 * engine; the Home id only names which Home to look up. A tool the person may not use, a tool
 * that does not exist and a Home they do not belong to all answer the same 403.
 */

const MAX_BODY_BYTES = 1024;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(status: number, error: OraToolsErrorCode): Response {
  return json(status, { error });
}

function refusal(result: Exclude<OraToolContextResult, { status: "ok" }>): Response {
  if (result.status === "unauthenticated") return failure(401, "unauthenticated");
  if (result.status === "forbidden") return failure(403, "forbidden");
  return failure(503, "unavailable");
}

export async function GET(request: Request): Promise<Response> {
  const homeId = new URL(request.url).searchParams.get("homeId");
  const resolved = await resolveOraToolContext(homeId);
  if (resolved.status !== "ok") return refusal(resolved);
  return json(200, { tools: availableTools(resolved.context) } satisfies OraToolsResponse);
}

const runSchema = z.strictObject({
  tool: z.string().min(1).max(64),
  homeId: z.string().max(64).nullish(),
});

export async function POST(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return failure(refused.status, refused.error);

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return failure(body.status, body.error);
  const parsed = runSchema.safeParse(body.body);
  if (!parsed.success) return failure(400, "invalid");

  const resolved = await resolveOraToolContext(parsed.data.homeId);
  if (resolved.status !== "ok") return refusal(resolved);

  const result = runTool(resolved.context, parsed.data.tool);
  if (result.status !== "ok") return failure(403, "forbidden");
  return json(200, { output: result.output } satisfies OraToolRunResponse);
}
