import { z } from "zod";

/**
 * The dashboard request contract (S17, versioned for later mobile clients). Client-safe. Layouts
 * themselves are checked with `checkLayout` against the registry and the person's Homes; the
 * database checks shape, size, revision and authority again.
 */

export const dashboardTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal") }),
  z.strictObject({ kind: z.literal("home"), homeId: z.uuid() }),
]);
export type DashboardTarget = z.infer<typeof dashboardTargetSchema>;

const revision = z.int().min(0).max(2_147_483_647);

export const saveDashboardSchema = z.strictObject({
  target: dashboardTargetSchema,
  /** Checked by `checkLayout`, which needs the registry and the person's Homes. */
  layout: z.unknown(),
  expectedRevision: revision,
});

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
