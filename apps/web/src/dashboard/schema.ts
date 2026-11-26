import { z } from "zod";

/**
 * The dashboard request contract (S17, versioned for later mobile clients). Client-safe. Layouts
 * themselves are checked with `checkLayout` against the registry and the person's Homes; the
 * database checks shape, size, revision and authority again.
 */

export const dashboardTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal") }),
  z.strictObject({
    kind: z.literal("home"),
    homeId: z.uuid(),
    /**
     * Which of the Home's dashboards (UX2d; decision 33): the shared default (none, the same as
     * before), or the person's own "My Home view" of it.
     */
    view: z.enum(["default", "mine"]).optional(),
  }),
]);
export type DashboardTarget = z.infer<typeof dashboardTargetSchema>;

const revision = z.int().min(0).max(2_147_483_647);

export const saveDashboardSchema = z.strictObject({
  target: dashboardTargetSchema,
  /** Checked by `checkLayout`, which needs the registry and the person's Homes. */
  layout: z.unknown(),
  expectedRevision: revision,
  /**
   * Done in edit mode (UX2b): discards the person's draft of this dashboard in the same transaction
   * when the save succeeds. On a conflict the draft stays.
   */
  commitDraft: z.boolean().optional(),
});

/** Autosaves an edit-mode draft (UX2b; decision 6). Never changes the dashboard itself. */
export const saveDraftSchema = z.strictObject({
  target: dashboardTargetSchema,
  /** Checked by `checkLayout`, like a save. */
  layout: z.unknown(),
  /** The committed revision the draft started from (0: the starter). */
  baseRevision: revision,
});

export const discardDraftSchema = z.strictObject({ target: dashboardTargetSchema });

export const resetDashboardSchema = z.strictObject({
  target: dashboardTargetSchema,
  expectedRevision: revision,
});
export const undoDashboardSchema = resetDashboardSchema;

export const builtInTemplateIds = ["starter-personal", "starter-home"] as const;

export const applyTemplateSchema = z.strictObject({
  target: dashboardTargetSchema,
  expectedRevision: revision,
  template: z.union([
    z.strictObject({ builtIn: z.enum(builtInTemplateIds) }),
    z.strictObject({ id: z.uuid() }),
  ]),
});

/** Same rule as the database: 1–80 characters, no surrounding spaces, no control characters. */
export const TEMPLATE_NAME_MAX = 80;
export const templateNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TEMPLATE_NAME_MAX)
  // eslint-disable-next-line no-control-regex -- the rule is exactly "no control characters"
  .refine((name) => !/[\u0000-\u001f\u007f-\u009f]/.test(name));

export const createTemplateSchema = z.strictObject({
  name: templateNameSchema,
  /** The dashboard whose current layout becomes the template. */
  from: dashboardTargetSchema,
});

export const renameTemplateSchema = z.strictObject({ name: templateNameSchema });

export const templateIdSchema = z.uuid();

/** Same limit as the database (`private.dashboard_limit('templates')`). */
export const TEMPLATE_LIMIT = 50;

/** A copy of a visible template as a new private template of the person's own (UX2c). */
export const duplicateTemplateSchema = z.strictObject({ name: templateNameSchema });

/**
 * Restores one version of a dashboard's history as a new commit (UX2c; decision 32). The version
 * must belong to `target`; `expectedRevision` is the dashboard's revision the person saw (a history
 * exists only once something was saved, so never 0).
 */
export const restoreVersionSchema = z.strictObject({
  target: dashboardTargetSchema,
  versionId: z.uuid(),
  expectedRevision: revision.min(1),
});

/** Ends the person's own view of a Home: they see the shared default again (UX2d; decision 33). */
export const resetHomeViewSchema = z.strictObject({ homeId: z.uuid() });

/** Dismisses shared-default additions the person does not want in their view (decision 34). */
export const dismissSuggestionsSchema = z.strictObject({
  homeId: z.uuid(),
  /** A dashboard holds at most 40 widgets (`MAX_WIDGETS`). */
  widgetIds: z.array(z.uuid()).min(1).max(40),
});
