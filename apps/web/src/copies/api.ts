import { COPY_OUTCOMES, type CopyOutcome } from "./catalogue";
import type { CopyDecisionInput, CopyRequestInput } from "./schema";

/**
 * The HTTP contract of the personal-to-Home copy endpoints (S40 part 2; versioned, so later mobile
 * clients can use them too), and the browser's callers. Cookie-authenticated, same-origin JSON.
 *
 * - `POST /api/v1/me/home-copies` `{ itemType, itemId, homeIds }` → `200 { batchId, homes:
 *   [{ homeId, outcome, requestId?, code? }] }`; `404 not-found` (not the person's own eligible
 *   item); `429 rate-limited` (too many open requests)
 * - `POST /api/v1/me/home-copies/{requestId}/cancel` `{}` → `200 { cancelled }`
 * - `POST /api/v1/me/home-copies/cancel-pending` `{}` → `200 { cancelled: number }`
 * - `POST /api/v1/home-copies/{requestId}/decision` `{ approve }` → `200 { outcome }` (an approver
 *   of the request's Home; `404 not-found` for anyone else)
 *
 * Errors: `401 unauthenticated`, `400 invalid`, `403 forbidden` (cross-site), `413 too-large`,
 * `415 unsupported-media-type`, `500 failed`.
 */
export const HOME_COPIES_ENDPOINT = "/api/v1/me/home-copies";

export type CopyFailure =
  "signedOut" | "invalid" | "notFound" | "rateLimited" | "network" | "failed";

export class CopyActionError extends Error {
  constructor(readonly failure: CopyFailure) {
    super(`Copy action failed: ${failure}`);
    this.name = "CopyActionError";
  }
}

const failures: Record<string, CopyFailure> = {
  invalid: "invalid",
  "not-found": "notFound",
  "rate-limited": "rateLimited",
};

async function send(url: string, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new CopyActionError("network");
  }
  const json = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new CopyActionError("signedOut");
    const code = typeof json.error === "string" ? json.error : "";
    throw new CopyActionError(failures[code] ?? "failed");
  }
  return json;
}

export interface HomeCopyOutcome {
  readonly homeId: string;
  readonly outcome: CopyOutcome;
  readonly code: string | null;
}

export async function requestHomeCopies(input: CopyRequestInput): Promise<HomeCopyOutcome[]> {
  const body = await send(HOME_COPIES_ENDPOINT, input);
  if (!Array.isArray(body.homes)) throw new CopyActionError("failed");
  return body.homes.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.homeId !== "string") return [];
    const outcome = (COPY_OUTCOMES as readonly unknown[]).includes(row.outcome)
      ? (row.outcome as CopyOutcome)
      : "failed";
    return [{ homeId: row.homeId, outcome, code: typeof row.code === "string" ? row.code : null }];
  });
}

export async function cancelHomeCopy(requestId: string): Promise<boolean> {
  const body = await send(`${HOME_COPIES_ENDPOINT}/${encodeURIComponent(requestId)}/cancel`, {});
  return body.cancelled === true;
}

export async function cancelPendingHomeCopies(): Promise<number> {
  const body = await send(`${HOME_COPIES_ENDPOINT}/cancel-pending`, {});
  return typeof body.cancelled === "number" ? body.cancelled : 0;
}

export function decisionEndpoint(requestId: string): string {
  return `/api/v1/home-copies/${encodeURIComponent(requestId)}/decision`;
}

export async function decideHomeCopy(requestId: string, input: CopyDecisionInput): Promise<string> {
  const body = await send(decisionEndpoint(requestId), input);
  return typeof body.outcome === "string" ? body.outcome : "failed";
}
