import type { TrashItemType, TrashModule, TrashResolution, TrashResolutionChoice } from "./schema";

/**
 * The HTTP contract of trash and recovery (S16):
 *
 * - `GET /api/v1/trash?homeId&module&itemType&deletedFrom&deletedTo` → `200 { entries }`: the
 *   signed-in person's personal trash, or a Home's they belong to, limited to what they may see.
 * - `POST /api/v1/trash/restore` `{ entryIds, resolutions? }` → `200 { results }`, one per entry.
 * - `POST /api/v1/trash/purge` `{ entryIds, confirm: true }` → `200 { results }`.
 * - `POST /api/v1/trash/empty` `{ homeId?, deletedBefore, confirm: true }` → `200 { results }`.
 *
 * Restoring and deleting are decided per entry, so a request that mixes outcomes still answers 200.
 */
export const TRASH_ENDPOINT = "/api/v1/trash";
export const TRASH_RESTORE_ENDPOINT = "/api/v1/trash/restore";
export const TRASH_PURGE_ENDPOINT = "/api/v1/trash/purge";
export const TRASH_EMPTY_ENDPOINT = "/api/v1/trash/empty";

export type TrashErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "failed";

export interface TrashErrorResponse {
  readonly error: TrashErrorCode;
  readonly fields?: readonly string[];
}

export interface TrashEntry {
  readonly id: string;
  readonly module: TrashModule;
  readonly itemType: TrashItemType;
  readonly label: string;
  readonly deletedAt: string;
  readonly expiresAt: string;
  readonly deletedByMe: boolean;
  readonly fileCount: number;
}

export interface TrashListResponse {
  readonly entries: readonly TrashEntry[];
}

export type RestoreOutcome = "restored" | "needs_resolution" | "expired" | "not_found" | "failed";
export type PurgeOutcome = "purged" | "not_found" | "failed";

export interface RestoreResult {
  readonly entryId: string;
  readonly outcome: RestoreOutcome;
  /** What stands in the way, for `needs_resolution`. */
  readonly conflict: string | null;
  /** What the person may choose, for `needs_resolution`. */
  readonly options: readonly TrashResolution[];
  /** Files that could not come back with a restored item. */
  readonly attachmentsLost: number;
}

export interface PurgeResult {
  readonly entryId: string;
  readonly outcome: PurgeOutcome;
}

export interface RestoreResponse {
  readonly results: readonly RestoreResult[];
}
export interface PurgeResponse {
  readonly results: readonly PurgeResult[];
}

/** Why a trash request failed as a whole (not per entry), in words the page can explain. */
export type TrashFailure = "signedOut" | "invalid" | "network" | "failed";

export class TrashRequestError extends Error {
  constructor(readonly failure: TrashFailure) {
    super(`Trash request failed: ${failure}`);
    this.name = "TrashRequestError";
  }
}

function failureFor(code: unknown): TrashFailure {
  if (code === "unauthenticated") return "signedOut";
  if (code === "invalid" || code === "not-found") return "invalid";
  return "failed";
}

async function post(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new TrashRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new TrashRequestError(failureFor(code));
  }
  return payload;
}

function resultsOf(payload: unknown): unknown[] {
  if (payload && typeof payload === "object" && "results" in payload) {
    const { results } = payload;
    if (Array.isArray(results)) return results as unknown[];
  }
  throw new TrashRequestError("failed");
}

const restoreOutcomes: readonly RestoreOutcome[] = [
  "restored",
  "needs_resolution",
  "expired",
  "not_found",
  "failed",
];
const purgeOutcomes: readonly PurgeOutcome[] = ["purged", "not_found", "failed"];

export function readRestoreResults(payload: unknown): RestoreResult[] {
  return resultsOf(payload).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const outcome = restoreOutcomes.find((candidate) => candidate === row.outcome);
    if (typeof row.entryId !== "string" || !outcome) throw new TrashRequestError("failed");
    return {
      entryId: row.entryId,
      outcome,
      conflict: typeof row.conflict === "string" ? row.conflict : null,
      options: Array.isArray(row.options)
        ? row.options.filter((option): option is TrashResolution => typeof option === "string")
        : [],
      attachmentsLost: typeof row.attachmentsLost === "number" ? row.attachmentsLost : 0,
    };
  });
}

export function readPurgeResults(payload: unknown): PurgeResult[] {
  return resultsOf(payload).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const outcome = purgeOutcomes.find((candidate) => candidate === row.outcome);
    if (typeof row.entryId !== "string" || !outcome) throw new TrashRequestError("failed");
    return { entryId: row.entryId, outcome };
  });
}

export async function restoreEntries(
  entryIds: readonly string[],
  resolutions: Readonly<Record<string, TrashResolutionChoice>> = {},
): Promise<RestoreResult[]> {
  return readRestoreResults(await post(TRASH_RESTORE_ENDPOINT, { entryIds, resolutions }));
}

export async function purgeEntries(entryIds: readonly string[]): Promise<PurgeResult[]> {
  return readPurgeResults(await post(TRASH_PURGE_ENDPOINT, { entryIds, confirm: true }));
}

export async function emptyTrash(
  homeId: string | null,
  deletedBefore: string,
): Promise<PurgeResult[]> {
  return readPurgeResults(
    await post(TRASH_EMPTY_ENDPOINT, { homeId, deletedBefore, confirm: true }),
  );
}
