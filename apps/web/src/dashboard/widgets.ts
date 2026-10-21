import { z } from "zod";

/**
 * The widget registry (S17; MOD §4.1; architecture.md §15). Client-safe and framework-free: the
 * catalogue, the layout validator and the editor all read it, and the server validates every saved
 * layout against it. Each module step adds its own widget types here (tasks S18, calendar S32 …),
 * with the data loader and component that render them.
 *
 * S17 ships only widgets backed by real, existing data: nothing is invented to fill a dashboard
 * (spec "Confirmed editable starter personal dashboard": never fabricate events, tasks or members).
 */

/**
 * Where a widget may appear:
 * - `personal`: the person's own personal dashboard, with personal data;
 * - `home`: a Home's shared dashboard, scoped to that Home;
 * - `home-source`: on the personal dashboard, bound to one explicitly selected Home the person
 *   belongs to (spec "Confirmed selected Home widgets on the global personal dashboard").
 */
export const widgetSurfaces = ["personal", "home", "home-source"] as const;
export type WidgetSurface = (typeof widgetSurfaces)[number];

/** Which dashboard a layout belongs to. */
export type DashboardKind = "personal" | "home";

export const breakpoints = ["lg", "md", "sm"] as const;
export type Breakpoint = (typeof breakpoints)[number];

/** Columns per breakpoint, chosen by the dashboard's own width (container queries). */
export const breakpointColumns: { readonly [B in Breakpoint]: number } = { lg: 12, md: 6, sm: 1 };
/** Minimum container width in px for each breakpoint (React Grid Layout's `breakpoints`). */
export const breakpointMinWidths: { readonly [B in Breakpoint]: number } = {
  lg: 1024,
  md: 640,
  sm: 0,
};
/** The breakpoint for a dashboard `width` px wide: the same rule as the CSS container queries. */
export function breakpointFor(width: number): Breakpoint {
  if (width >= breakpointMinWidths.lg) return "lg";
  if (width >= breakpointMinWidths.md) return "md";
  return "sm";
}
/** Space between widgets, in px (Tailwind `gap-4`). */
export const GRID_GAP = 16;
/** One grid row, in px. */
export const ROW_HEIGHT = 88;

export interface SizeBounds {
  /** Size of a newly added widget. */
  readonly w: number;
  readonly h: number;
  readonly minW: number;
  readonly maxW: number;
  readonly minH: number;
  readonly maxH: number;
}

export interface WidgetDefinition<C extends z.ZodType = z.ZodType> {
  readonly surfaces: readonly WidgetSurface[];
  readonly sizes: { readonly [B in Breakpoint]: SizeBounds };
  /** The widget's settings; `parse(undefined)`-safe defaults for every field. */
  readonly config: C;
}

function sizes(
  lg: SizeBounds,
  md: SizeBounds,
  sm: Pick<SizeBounds, "h" | "minH" | "maxH">,
): { readonly [B in Breakpoint]: SizeBounds } {
  return { lg, md, sm: { ...sm, w: 1, minW: 1, maxW: 1 } };
}

const welcomeConfig = z.strictObject({ showDate: z.boolean().default(true) });
const quickActionsConfig = z.strictObject({});
export const notificationCounts = [3, 5, 10] as const;
const notificationsConfig = z.strictObject({
  count: z.union([z.literal(3), z.literal(5), z.literal(10)]).default(5),
});
const homeMembersConfig = z.strictObject({ showRoles: z.boolean().default(true) });

/**
 * The tasks widget (S19c; spec "Confirmed configurable task dashboard widgets"): one list or All
 * Tasks of the widget's context (the Personal space, the Home, or the source Home), with the same
 * filters as the full Tasks module. Ids of lists, labels and members are checked again when the
 * widget renders; one that no longer exists shows an explicit state, never a substitute.
 */
export const taskWidgetCounts = [5, 10, 15] as const;
export const taskWidgetStatuses = ["open", "completed", "all"] as const;
export const taskWidgetWhens = [
  "any",
  "overdue",
  "due_today",
  "due_week",
  "upcoming",
  "undated",
] as const;
export const taskWidgetPriorities = ["low", "normal", "high", "urgent", "unset"] as const;
export const taskWidgetAssignees = ["any", "me", "unassigned", "member"] as const;
const tasksConfig = z.strictObject({
  /** null: All Tasks. */
  listId: z.uuid().nullable().default(null),
  status: z.enum(taskWidgetStatuses).default("open"),
  when: z.enum(taskWidgetWhens).default("any"),
  priorities: z.array(z.enum(taskWidgetPriorities)).max(taskWidgetPriorities.length).default([]),
  labelIds: z.array(z.uuid()).max(20).default([]),
  /** Home widgets only; 'member' names memberId (a membership id). */
  assignee: z.enum(taskWidgetAssignees).default("any"),
  memberId: z.uuid().nullable().default(null),
  count: z.union([z.literal(5), z.literal(10), z.literal(15)]).default(5),
});

/**
 * The chore widgets (S20; spec "Confirmed configurable chore dashboard widgets"): always one Home
 * (on its own dashboard, or bound to one on the personal dashboard; chores are Home-only). My Chores
 * shows the viewer's own, All Home Chores everyone's (or one member's, or unassigned ones), Pending
 * Approvals the review queue for chore reviewers only. Dates are relative to the Home's today, so
 * a saved setting keeps its meaning: due ones by due date, completed ones by completion date.
 */
export const choreWidgetCounts = [5, 10, 15] as const;
export const choreWidgetStates = [
  "outstanding",
  "overdue",
  "pending_approval",
  "rework",
  "completed",
] as const;
export const choreWidgetRanges = ["any", "today", "next_7_days", "past_7_days"] as const;
export const choreWidgetAssignees = ["any", "unassigned", "member"] as const;
const choreCount = z.union([z.literal(5), z.literal(10), z.literal(15)]).default(5);
const myChoresConfig = z.strictObject({
  state: z.enum(choreWidgetStates).default("outstanding"),
  range: z.enum(choreWidgetRanges).default("any"),
  count: choreCount,
});
const homeChoresConfig = z.strictObject({
  state: z.enum(choreWidgetStates).default("outstanding"),
  range: z.enum(choreWidgetRanges).default("any"),
  /** 'member' names memberId (a membership id). */
  assignee: z.enum(choreWidgetAssignees).default("any"),
  memberId: z.uuid().nullable().default(null),
  count: choreCount,
});
const choreApprovalsConfig = z.strictObject({ count: choreCount });

const choreSizes = sizes(
  { w: 6, h: 4, minW: 4, maxW: 12, minH: 3, maxH: 10 },
  { w: 6, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 10 },
  { h: 5, minH: 3, maxH: 10 },
);

export const widgetRegistry = {
  welcome: {
    surfaces: ["personal", "home"],
    sizes: sizes(
      { w: 6, h: 2, minW: 3, maxW: 12, minH: 2, maxH: 3 },
      { w: 6, h: 2, minW: 3, maxW: 6, minH: 2, maxH: 3 },
      { h: 2, minH: 2, maxH: 3 },
    ),
    config: welcomeConfig,
  },
  "quick-actions": {
    surfaces: ["personal", "home"],
    sizes: sizes(
      { w: 6, h: 2, minW: 3, maxW: 12, minH: 2, maxH: 4 },
      { w: 6, h: 2, minW: 3, maxW: 6, minH: 2, maxH: 4 },
      { h: 3, minH: 2, maxH: 5 },
    ),
    config: quickActionsConfig,
  },
  notifications: {
    surfaces: ["personal"],
    sizes: sizes(
      { w: 6, h: 4, minW: 4, maxW: 12, minH: 3, maxH: 8 },
      { w: 6, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 8 },
      { h: 4, minH: 3, maxH: 8 },
    ),
    config: notificationsConfig,
  },
  "home-members": {
    surfaces: ["home", "home-source"],
    sizes: sizes(
      { w: 6, h: 4, minW: 4, maxW: 12, minH: 3, maxH: 8 },
      { w: 6, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 8 },
      { h: 4, minH: 3, maxH: 8 },
    ),
    config: homeMembersConfig,
  },
  tasks: {
    surfaces: ["personal", "home", "home-source"],
    sizes: sizes(
      { w: 6, h: 4, minW: 4, maxW: 12, minH: 3, maxH: 10 },
      { w: 6, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 10 },
      { h: 5, minH: 3, maxH: 10 },
    ),
    config: tasksConfig,
  },
  "my-chores": {
    surfaces: ["home", "home-source"],
    sizes: choreSizes,
    config: myChoresConfig,
  },
  "home-chores": {
    surfaces: ["home", "home-source"],
    sizes: choreSizes,
    config: homeChoresConfig,
  },
  "chore-approvals": {
    surfaces: ["home", "home-source"],
    sizes: choreSizes,
    config: choreApprovalsConfig,
  },
} as const satisfies { readonly [type: string]: WidgetDefinition };

export type WidgetType = keyof typeof widgetRegistry;
export const widgetTypes = Object.keys(widgetRegistry) as readonly WidgetType[];

export type WidgetConfig<T extends WidgetType> = z.output<(typeof widgetRegistry)[T]["config"]>;
/** Every widget's settings, by type, for code that switches on the type. */
export interface WidgetConfigs {
  readonly welcome: WidgetConfig<"welcome">;
  readonly "quick-actions": WidgetConfig<"quick-actions">;
  readonly notifications: WidgetConfig<"notifications">;
  readonly "home-members": WidgetConfig<"home-members">;
  readonly tasks: WidgetConfig<"tasks">;
  readonly "my-chores": WidgetConfig<"my-chores">;
  readonly "home-chores": WidgetConfig<"home-chores">;
  readonly "chore-approvals": WidgetConfig<"chore-approvals">;
}

export function isWidgetType(value: unknown): value is WidgetType {
  return typeof value === "string" && Object.hasOwn(widgetRegistry, value);
}

/** Whether a widget of `type` may sit on `dashboard`, either directly or bound to a source Home. */
export function surfaceFor(
  type: WidgetType,
  dashboard: DashboardKind,
  hasSource: boolean,
): WidgetSurface | null {
  const surfaces: readonly WidgetSurface[] = widgetRegistry[type].surfaces;
  if (dashboard === "home") return !hasSource && surfaces.includes("home") ? "home" : null;
  if (hasSource) return surfaces.includes("home-source") ? "home-source" : null;
  return surfaces.includes("personal") ? "personal" : null;
}

/**
 * The widgets that may be added to a dashboard, with whether each needs a source Home. A type that
 * works both with personal data and bound to a Home (tasks) is offered once for each.
 */
export function catalogueFor(
  dashboard: DashboardKind,
): readonly { readonly type: WidgetType; readonly needsSource: boolean }[] {
  return widgetTypes.flatMap((type) =>
    [false, true]
      .filter((needsSource) => surfaceFor(type, dashboard, needsSource) !== null)
      .map((needsSource) => ({ type, needsSource })),
  );
}

/** A widget type's default settings. */
export function defaultConfig(type: WidgetType): Record<string, unknown> {
  return widgetRegistry[type].config.parse({});
}

/** Parses settings for a type, or null when they do not fit it. */
export function parseConfig(type: WidgetType, value: unknown): Record<string, unknown> | null {
  const parsed = widgetRegistry[type].config.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}
