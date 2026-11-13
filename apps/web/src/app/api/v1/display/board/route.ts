import { z } from "zod";

import { getAuthState } from "@/auth/identity";
import { getDisplayBoard } from "@/displays/board";
import { displayJson, readDisplayRequest } from "@/displays/route-helpers";

const MAX_BODY_BYTES = 16;

/**
 * A paired display reads what it shows (S44): on a Realtime signal and every minute, which is also
 * its heartbeat. `401 not-paired` once it was revoked or its Home closed, so the screen returns to
 * the pairing screen without keeping anything it had.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDisplayRequest(request, z.strictObject({}), MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  if ((await getAuthState()).kind !== "display") return displayJson(401, { error: "not-paired" });
  const result = await getDisplayBoard();
  if (result.kind === "refused") return displayJson(401, { error: "not-paired" });
  if (result.kind === "unavailable") return displayJson(503, { error: "unavailable" });
  return displayJson(200, { board: result.board });
}
