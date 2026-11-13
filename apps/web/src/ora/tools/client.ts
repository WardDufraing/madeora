import type { OraToolId } from "./ids";
import type { OraToolOutput, OraToolRunResponse, OraToolSummary, OraToolsResponse } from "./types";

/** The browser's callers for `/api/v1/ora/tools`. */
const ENDPOINT = "/api/v1/ora/tools";

/**
 * Why a call failed: `signedOut` (session ended), `forbidden` (no access to this place or tool
 * any more), `unavailable` (Ora's service could not be reached or answered with an error).
 */
export type OraToolFailure = "signedOut" | "forbidden" | "unavailable";

export class OraToolError extends Error {
  constructor(readonly failure: OraToolFailure) {
    super(`Ora tool call failed: ${failure}`);
    this.name = "OraToolError";
  }
}

function failureFor(status: number): OraToolFailure {
  if (status === 401) return "signedOut";
  if (status === 403) return "forbidden";
  return "unavailable";
}

/** What Ora may offer the person in Personal space (`homeId` null) or one Home. */
export async function fetchOraTools(homeId: string | null): Promise<readonly OraToolSummary[]> {
  const query = homeId === null ? "" : `?homeId=${encodeURIComponent(homeId)}`;
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}${query}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new OraToolError("unavailable");
  }
  if (!response.ok) throw new OraToolError(failureFor(response.status));
  const body = (await response.json().catch(() => null)) as Partial<OraToolsResponse> | null;
  const tools: unknown = body?.tools;
  if (!Array.isArray(tools)) throw new OraToolError("unavailable");
  return tools as readonly OraToolSummary[];
}

export async function callOraTool(
  homeId: string | null,
  tool: OraToolId,
  input?: unknown,
): Promise<OraToolOutput> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input === undefined ? { tool, homeId } : { tool, homeId, input }),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new OraToolError("unavailable");
  }
  if (!response.ok) throw new OraToolError(failureFor(response.status));
  const body = (await response.json().catch(() => null)) as Partial<OraToolRunResponse> | null;
  if (!body?.output) throw new OraToolError("unavailable");
  return body.output;
}

/** A path inside Madeora: never another site, never a protocol-relative address. */
export function isInternalPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && !href.includes("\\");
}
