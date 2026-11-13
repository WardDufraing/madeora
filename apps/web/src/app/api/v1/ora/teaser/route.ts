import { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { claimTeaser } from "@/ora/suggestions/server";
import type { OraTeaserResponse } from "@/ora/suggestions/types";
import { resolveOraToolContext } from "@/ora/tools/server";

/**
 * Claims the person's one unsolicited teaser for today (S47). The limit is kept in the database
 * (once per person per local date, across every Home and device, never while muted), so asking again
 * from another tab, device or Home answers with no teaser.
 */

const MAX_BODY_BYTES = 256;
const bodySchema = z.strictObject({ homeId: z.uuid().nullable() });

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return json(refused.status, { error: refused.error });
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.error });
  const parsed = bodySchema.safeParse(body.body);
  if (!parsed.success) return json(400, { error: "invalid" });

  const resolved = await resolveOraToolContext(parsed.data.homeId);
  if (resolved.status === "unauthenticated") return json(401, { error: "unauthenticated" });
  if (resolved.status === "forbidden") return json(403, { error: "forbidden" });
  if (resolved.status !== "ok") return json(503, { error: "unavailable" });

  const result = await claimTeaser(resolved.context);
  if (result.status !== "ok") return json(503, { error: "unavailable" });
  return json(200, { teaser: result.teaser } satisfies OraTeaserResponse);
}
