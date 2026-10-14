import "server-only";

import { getPublicEnv } from "@madeora/config/env/public";

import { isSameOriginRequest } from "@/auth/same-origin";

/**
 * The checks every cookie-authenticated JSON mutation in `/api/v1` makes before it looks at the
 * body (architecture.md §7, §21): cross-site requests are refused (CSRF), only JSON is accepted
 * (which a cross-site form cannot send), and the body is read no further than `maxBytes`.
 */

export type JsonRequestError = "forbidden" | "unsupported-media-type" | "too-large" | "invalid";

export type JsonRequestResult =
  | { readonly ok: true; readonly body: unknown }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 413 | 415;
      readonly error: JsonRequestError;
    };

/** Refuses cross-site requests and anything but a JSON body; returns the status and code if so. */
export function checkJsonMutation(
  request: Request,
  maxBytes: number,
): Extract<JsonRequestResult, { ok: false }> | null {
  if (!isSameOriginRequest(request.headers, getPublicEnv().NEXT_PUBLIC_APP_URL)) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(?:;|$)/i.test(contentType)) {
    return { ok: false, status: 415, error: "unsupported-media-type" };
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^\d+$/.test(declaredLength)) {
    return { ok: false, status: 400, error: "invalid" };
  }
  if (Number(declaredLength ?? 0) > maxBytes) {
    return { ok: false, status: 413, error: "too-large" };
  }
  return null;
}

/** The body as text, or `null` once it grows past `limit` bytes (read no further than that). */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads and parses the JSON body, at most `maxBytes` long. Call after `checkJsonMutation`. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonRequestResult> {
  const text = await readLimited(request, maxBytes);
  if (text === null) return { ok: false, status: 413, error: "too-large" };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: "invalid" };
  }
}

/** The names of the fields a Zod error refused, for a 400 response. */
export function refusedFields(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): string[] {
  const fields = new Set(issues.map((issue) => issue.path.map(String).join(".")));
  return [...fields].filter(Boolean);
}
