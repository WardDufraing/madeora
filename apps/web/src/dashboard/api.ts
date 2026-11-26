import { z } from "zod";

import type { DashboardLayout } from "./layout";
import { layoutPreviewSchema, type LayoutPreview } from "./preview";
import type { DashboardTarget } from "./schema";
import type { BuiltInTemplateId } from "./starter";
import { targetQuery } from "./target-args";

/**
 * The HTTP contract of dashboards and templates (S17). Every mutation is same-origin JSON and
 * checked again by the database with the person's own session.
 *
 * - `PUT /api/v1/dashboard` `{ target, layout, expectedRevision }` → `200 { revision }`.
 * - `POST /api/v1/dashboard/reset` `{ target, expectedRevision }` → `200 { revision }`: back to the
 *   starter layout, undoable once.
 * - `POST /api/v1/dashboard/undo` `{ target, expectedRevision }` → `200 { revision }`.
 * - `POST /api/v1/dashboard/apply-template` `{ target, expectedRevision, template }` →
 *   `200 { revision, dropped }`, undoable once.
 * - `GET /api/v1/dashboard-templates?homeId` → `200 { templates }`.
 * - `POST /api/v1/dashboard-templates` `{ name, from }` → `201 { id, dropped }`.
 * - `PATCH /api/v1/dashboard-templates/:id` `{ name }`, `DELETE …/:id` `{}` (to the trash).
 * - `PUT` / `DELETE /api/v1/dashboard-templates/:id/shares/:homeId` `{}`.
 *
 * - `GET /api/v1/dashboard/draft?homeId` → `200 { draft }`; `PUT …/draft` `{ target, layout,
 *   baseRevision }` → `200 { updatedAt }`; `DELETE …/draft` `{ target }` (UX2b edit-mode drafts).
 *   `PUT /api/v1/dashboard` with `commitDraft: true` is Done: it commits and drops the draft.
 *
 * - `GET /api/v1/dashboard/history?homeId` → `200 { versions }`; `POST …/history/restore`
 *   `{ target, versionId, expectedRevision }` → `200 { revision }` (UX2c version history).
 * - `POST /api/v1/dashboard-templates/:id/duplicate` `{ name }` → `201 { id, dropped }` (UX2c).
 *
 * `409 conflict` (with the current `revision`) means someone saved the dashboard since it was read.
 */
export const DASHBOARD_ENDPOINT = "/api/v1/dashboard";
export const DASHBOARD_TEMPLATES_ENDPOINT = "/api/v1/dashboard-templates";

export type DashboardErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "conflict"
  | "nothing-to-undo"
  | "limit-reached"
  | "name-taken"
  | "unavailable"
  | "failed";

export interface DashboardErrorResponse {
  readonly error: DashboardErrorCode;
  readonly revision?: number;
  readonly fields?: readonly string[];
}

export interface RevisionResponse {
  readonly revision: number;
  /** Widgets a template could not bring along (Home-bound widgets in a personal template). */
  readonly dropped?: number;
}

export interface TemplateCreatedResponse {
  readonly id: string;
  readonly dropped: number;
}

/** Why a dashboard request failed, in words the interface can explain. */
export type DashboardFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "conflict"
  | "nothingToUndo"
  | "limitReached"
  | "nameTaken"
  | "network"
  | "failed";

export class DashboardRequestError extends Error {
  constructor(
    readonly failure: DashboardFailure,
    /** The dashboard's current revision, for a conflict. */
    readonly revision: number | null = null,
  ) {
    super(`Dashboard request failed: ${failure}`);
    this.name = "DashboardRequestError";
  }
}

function failureFor(code: unknown): DashboardFailure {
  switch (code) {
    case "unauthenticated":
      return "signedOut";
    case "invalid":
      return "invalid";
    case "not-found":
      return "notFound";
    case "not-permitted":
      return "notPermitted";
    case "conflict":
      return "conflict";
    case "nothing-to-undo":
      return "nothingToUndo";
    case "limit-reached":
      return "limitReached";
    case "name-taken":
      return "nameTaken";
    default:
      return "failed";
  }
}

async function send(method: string, url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new DashboardRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as Record<
      string,
      unknown
    >;
    throw new DashboardRequestError(
      failureFor(record.error),
      typeof record.revision === "number" ? record.revision : null,
    );
  }
  return payload;
}

function revisionOf(payload: unknown): RevisionResponse {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (typeof record.revision !== "number") throw new DashboardRequestError("failed");
  return {
    revision: record.revision,
    dropped: typeof record.dropped === "number" ? record.dropped : 0,
  };
}

export async function saveDashboard(
  target: DashboardTarget,
  layout: DashboardLayout,
  expectedRevision: number,
  options: { readonly commitDraft?: boolean } = {},
): Promise<RevisionResponse> {
  return revisionOf(
    await send("PUT", DASHBOARD_ENDPOINT, {
      target,
      layout,
      expectedRevision,
      ...(options.commitDraft ? { commitDraft: true } : {}),
    }),
  );
}

export const DASHBOARD_DRAFT_ENDPOINT = `${DASHBOARD_ENDPOINT}/draft`;

/** A recoverable edit-mode draft as the server keeps it (UX2b). */
export interface DashboardDraft {
  readonly layout: DashboardLayout;
  /** The committed revision the draft started from. */
  readonly baseRevision: number;
  /** The dashboard's committed revision now; different means someone saved since. */
  readonly currentRevision: number;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

const draftResponseSchema = z.object({
  draft: z
    .object({
      // Already read with `readLayout` by the server.
      layout: z.custom<DashboardLayout>(
        (value) => typeof value === "object" && value !== null && "placements" in value,
      ),
      baseRevision: z.number().int().min(0),
      currentRevision: z.number().int().min(0),
      updatedAt: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
});

export async function fetchDraft(target: DashboardTarget): Promise<DashboardDraft | null> {
  const query = targetQuery(target);
  let response: Response;
  try {
    response = await fetch(`${DASHBOARD_DRAFT_ENDPOINT}${query}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new DashboardRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as Record<
      string,
      unknown
    >;
    throw new DashboardRequestError(failureFor(record.error));
  }
  const parsed = draftResponseSchema.safeParse(payload);
  if (!parsed.success) throw new DashboardRequestError("failed");
  return parsed.data.draft;
}

export async function saveDraft(
  target: DashboardTarget,
  layout: DashboardLayout,
  baseRevision: number,
): Promise<void> {
  await send("PUT", DASHBOARD_DRAFT_ENDPOINT, { target, layout, baseRevision });
}

export async function discardDraft(target: DashboardTarget): Promise<void> {
  await send("DELETE", DASHBOARD_DRAFT_ENDPOINT, { target });
}

export async function resetDashboard(
  target: DashboardTarget,
  expectedRevision: number,
): Promise<RevisionResponse> {
  return revisionOf(
    await send("POST", `${DASHBOARD_ENDPOINT}/reset`, { target, expectedRevision }),
  );
}

export async function undoDashboard(
  target: DashboardTarget,
  expectedRevision: number,
): Promise<RevisionResponse> {
  return revisionOf(await send("POST", `${DASHBOARD_ENDPOINT}/undo`, { target, expectedRevision }));
}

export async function applyTemplate(
  target: DashboardTarget,
  expectedRevision: number,
  template: { readonly builtIn: BuiltInTemplateId } | { readonly id: string },
): Promise<RevisionResponse> {
  return revisionOf(
    await send("POST", `${DASHBOARD_ENDPOINT}/apply-template`, {
      target,
      expectedRevision,
      template,
    }),
  );
}

const templateListSchema = z.object({
  templates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["personal", "home"]),
      isMine: z.boolean(),
      sharedHomeIds: z.array(z.string()),
      widgets: z.array(z.string()),
      /** Its arrangement for a preview (UX2c); absent from an older server. */
      preview: layoutPreviewSchema.optional(),
    }),
  ),
});

/** A template as the list answers it: what it contains and where, never widget settings. */
export type TemplateSummary = z.infer<typeof templateListSchema>["templates"][number];

/** Every template the person may see: their own, and those shared into their Homes. */
export async function fetchTemplates(): Promise<readonly TemplateSummary[]> {
  let response: Response;
  try {
    response = await fetch(DASHBOARD_TEMPLATES_ENDPOINT, {
      headers: { accept: "application/json" },
    });
  } catch {
    throw new DashboardRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new DashboardRequestError(response.status === 401 ? "signedOut" : "failed");
  }
  const parsed = templateListSchema.safeParse(payload);
  if (!parsed.success) throw new DashboardRequestError("failed");
  return parsed.data.templates;
}

export async function createTemplate(
  name: string,
  from: DashboardTarget,
): Promise<TemplateCreatedResponse> {
  const payload = await send("POST", DASHBOARD_TEMPLATES_ENDPOINT, { name, from });
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (typeof record.id !== "string") throw new DashboardRequestError("failed");
  return { id: record.id, dropped: typeof record.dropped === "number" ? record.dropped : 0 };
}

export async function renameTemplate(id: string, name: string): Promise<void> {
  await send("PATCH", `${DASHBOARD_TEMPLATES_ENDPOINT}/${encodeURIComponent(id)}`, { name });
}

export async function deleteTemplate(id: string): Promise<void> {
  await send("DELETE", `${DASHBOARD_TEMPLATES_ENDPOINT}/${encodeURIComponent(id)}`, {});
}

export async function setTemplateShare(id: string, homeId: string, shared: boolean): Promise<void> {
  await send(
    shared ? "PUT" : "DELETE",
    `${DASHBOARD_TEMPLATES_ENDPOINT}/${encodeURIComponent(id)}/shares/${encodeURIComponent(homeId)}`,
    {},
  );
}

export async function duplicateTemplate(
  id: string,
  name: string,
): Promise<TemplateCreatedResponse> {
  const payload = await send(
    "POST",
    `${DASHBOARD_TEMPLATES_ENDPOINT}/${encodeURIComponent(id)}/duplicate`,
    { name },
  );
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (typeof record.id !== "string") throw new DashboardRequestError("failed");
  return { id: record.id, dropped: typeof record.dropped === "number" ? record.dropped : 0 };
}

export const DASHBOARD_HISTORY_ENDPOINT = `${DASHBOARD_ENDPOINT}/history`;

const historySchema = z.object({
  versions: z.array(
    z.object({
      id: z.string(),
      revision: z.number().int().min(1),
      reason: z.enum(["save", "undo", "restore"]),
      savedByMe: z.boolean(),
      createdAt: z.string(),
      isCurrent: z.boolean(),
      dropped: z.boolean(),
      preview: layoutPreviewSchema,
    }),
  ),
});

/** One committed version of a dashboard (UX2c; decision 32), newest first in a history. */
export interface DashboardVersion {
  readonly id: string;
  readonly revision: number;
  readonly reason: "save" | "undo" | "restore";
  readonly savedByMe: boolean;
  readonly createdAt: string;
  readonly isCurrent: boolean;
  /** Something in this version can no longer be shown and is left out of the preview. */
  readonly dropped: boolean;
  readonly preview: LayoutPreview;
}

/** The dashboard's last committed versions, newest first; only for someone who may edit it. */
export async function fetchHistory(target: DashboardTarget): Promise<readonly DashboardVersion[]> {
  const query = targetQuery(target);
  let response: Response;
  try {
    response = await fetch(`${DASHBOARD_HISTORY_ENDPOINT}${query}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new DashboardRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as Record<
      string,
      unknown
    >;
    throw new DashboardRequestError(failureFor(record.error));
  }
  const parsed = historySchema.safeParse(payload);
  if (!parsed.success) throw new DashboardRequestError("failed");
  return parsed.data.versions;
}

/** Restores a version as a new commit; the layout it replaces stays in history (decision 32). */
export async function restoreVersion(
  target: DashboardTarget,
  versionId: string,
  expectedRevision: number,
): Promise<RevisionResponse> {
  return revisionOf(
    await send("POST", `${DASHBOARD_HISTORY_ENDPOINT}/restore`, {
      target,
      versionId,
      expectedRevision,
    }),
  );
}

/**
 * Ends the person's own view of a Home so they see the shared default again (UX2d; decision 33).
 * Its history and any unsaved draft go with it. Resolves to whether there was a view to end.
 */
export async function resetHomeView(homeId: string): Promise<boolean> {
  const payload = await send("DELETE", `${DASHBOARD_ENDPOINT}/home-view`, { homeId });
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return record.reset === true;
}

/** Dismisses shared-default additions so they are not offered again (decision 34). */
export async function dismissSuggestions(
  homeId: string,
  widgetIds: readonly string[],
): Promise<void> {
  await send("POST", `${DASHBOARD_ENDPOINT}/suggestions/dismiss`, { homeId, widgetIds });
}
