import { z } from "zod";

import type { DashboardLayout } from "./layout";
import type { DashboardTarget } from "./schema";
import type { BuiltInTemplateId } from "./starter";

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
): Promise<RevisionResponse> {
  return revisionOf(await send("PUT", DASHBOARD_ENDPOINT, { target, layout, expectedRevision }));
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
    }),
  ),
});

/** A template as the list answers it: what it contains, never its layout. */
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
