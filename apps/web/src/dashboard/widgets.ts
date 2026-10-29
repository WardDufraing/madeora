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

/**
 * The Chore schedule widget (S21; spec "Confirmed Home chore overview widget"): a Home-local week or
 * day of chores as a member-by-day matrix or daily grouped cards, with the week's unassigned chores
 * to claim. The settings hold the default layout and how many chores a cell shows before "+N more";
 * a viewer's own layout switch is remembered in their browser.
 */
export const choreScheduleLayouts = ["matrix", "cards"] as const;
export const choreScheduleLimits = [2, 3, 5] as const;
const choreScheduleConfig = z.strictObject({
  layout: z.enum(choreScheduleLayouts).default("matrix"),
  limit: z.union([z.literal(2), z.literal(3), z.literal(5)]).default(3),
});

/**
 * The Home vacation widget (S22; spec "Home vacation dashboard widget"): the active vacation, else
 * the next upcoming one, with its dates, scope and whether chores are paused. No settings.
 */
const homeVacationConfig = z.strictObject({});

/**
 * The points widgets (S23; spec "Confirmed weekly points dashboard widget", "Confirmed reward
 * leaderboard" and the points summary): Weekly points shows the viewer's own week or the shared
 * overview of participating members (never a ranking); Leaderboard the top members of a period
 * (the Home's default unless chosen), calm when the Home turned it off; My points the viewer's own
 * available and reserved points and the cheapest rewards they can afford. Never someone else's
 * balance.
 */
export const weeklyPointsViews = ["mine", "shared"] as const;
export const leaderboardWidgetPeriods = ["default", "week", "month", "all"] as const;
export const leaderboardWidgetCounts = [5, 10] as const;
const weeklyPointsConfig = z.strictObject({
  view: z.enum(weeklyPointsViews).default("mine"),
});
const pointsLeaderboardConfig = z.strictObject({
  period: z.enum(leaderboardWidgetPeriods).default("default"),
  count: z.union([z.literal(5), z.literal(10)]).default(5),
});
const myPointsConfig = z.strictObject({});
/**
 * The Personal points widget (S28b): the viewer's own personal balance and the cheapest of their own
 * rewards they can redeem. Personal dashboard only: never a Home dashboard, never a Home source, so
 * a Household Display never shows it (PS L100). No settings.
 */
const personalPointsConfig = z.strictObject({});
const pointsSizes = sizes(
  { w: 4, h: 3, minW: 3, maxW: 12, minH: 2, maxH: 8 },
  { w: 3, h: 3, minW: 3, maxW: 6, minH: 2, maxH: 8 },
  { h: 3, minH: 2, maxH: 8 },
);

/**
 * The Recipes widget (S24; spec "Confirmed configurable recipe dashboard widgets"): the viewer's
 * favorites, recently added, highest rated or one random recipe of its context (Personal space,
 * the Home, or a source Home), as 1, 3 or 5 cards (Random: one, with Show another). Drafts never
 * appear; the cards are read with the viewer's session.
 */
export const recipeWidgetModes = ["favorites", "recent", "top_rated", "random"] as const;
export const recipeWidgetCounts = [1, 3, 5] as const;
const recipesConfig = z.strictObject({
  mode: z.enum(recipeWidgetModes).default("favorites"),
  count: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(3),
});

/**
 * The Shopping widget (S26; spec "Confirmed shopping widget list selection and quick actions"): one
 * list, or up to five combined in the order chosen, of its context (Personal space, the Home, or a
 * source Home), with up to 5, 10 or 15 active items, check-off and quick add to one chosen
 * destination among the selected lists. A selected list that is archived, deleted or no longer
 * visible is left out and said so, never replaced.
 */
export const shoppingWidgetCounts = [5, 10, 15] as const;
export const SHOPPING_WIDGET_LISTS = 5;
const shoppingConfig = z
  .strictObject({
    listIds: z
      .array(z.uuid())
      .max(SHOPPING_WIDGET_LISTS)
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
    count: z.union([z.literal(5), z.literal(10), z.literal(15)]).default(5),
    /** Where quick add puts new items (one of the selected lists; null: no quick add). */
    quickAddListId: z.uuid().nullable().default(null),
  })
  .refine(
    (config) => config.quickAddListId === null || config.listIds.includes(config.quickAddListId),
  );

/**
 * The Meal planner widget (S27): today's meals, a chosen day's, or a compact week of its context
 * (Personal space, the Home, or a source Home), with quick add, edit, move and remove where the
 * viewer may edit the plan.
 */
export const mealWidgetModes = ["today", "day", "week"] as const;
const mealPlannerConfig = z
  .strictObject({
    mode: z.enum(mealWidgetModes).default("today"),
    /** The day "day" mode shows (YYYY-MM-DD); ignored otherwise. */
    date: z.iso.date().nullable().default(null),
  })
  .refine((config) => config.mode !== "day" || config.date !== null);

/** The Habits widget (S28): today's habits of its context, with Complete and Undo where allowed. */
export const habitWidgetCounts = [5, 10, 15] as const;
const habitsConfig = z.strictObject({
  count: z.union([z.literal(5), z.literal(10), z.literal(15)]).default(10),
});

/** The Habit insights widget (S28): one chosen habit's last 30 days (null: not chosen yet). */
const habitInsightsConfig = z.strictObject({
  habitId: z.uuid().nullable().default(null),
});

/** The Habit progress widget (S29): one chosen numeric habit's day, with quick-adds (null: not chosen). */
const habitProgressConfig = z.strictObject({
  habitId: z.uuid().nullable().default(null),
});

const habitSizes = sizes(
  { w: 4, h: 4, minW: 3, maxW: 12, minH: 3, maxH: 10 },
  { w: 3, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 10 },
  { h: 5, minH: 3, maxH: 10 },
);

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
  "chore-schedule": {
    surfaces: ["home", "home-source"],
    sizes: sizes(
      { w: 12, h: 5, minW: 6, maxW: 12, minH: 4, maxH: 10 },
      { w: 6, h: 5, minW: 4, maxW: 6, minH: 4, maxH: 10 },
      { h: 6, minH: 4, maxH: 10 },
    ),
    config: choreScheduleConfig,
  },
  "home-vacation": {
    surfaces: ["home", "home-source"],
    sizes: sizes(
      { w: 4, h: 2, minW: 3, maxW: 12, minH: 2, maxH: 4 },
      { w: 3, h: 2, minW: 3, maxW: 6, minH: 2, maxH: 4 },
      { h: 3, minH: 2, maxH: 4 },
    ),
    config: homeVacationConfig,
  },
  "weekly-points": {
    surfaces: ["home", "home-source"],
    sizes: pointsSizes,
    config: weeklyPointsConfig,
  },
  "points-leaderboard": {
    surfaces: ["home", "home-source"],
    sizes: pointsSizes,
    config: pointsLeaderboardConfig,
  },
  "my-points": {
    surfaces: ["home", "home-source"],
    sizes: pointsSizes,
    config: myPointsConfig,
  },
  "personal-points": {
    surfaces: ["personal"],
    sizes: pointsSizes,
    config: personalPointsConfig,
  },
  recipes: {
    surfaces: ["personal", "home", "home-source"],
    sizes: sizes(
      { w: 6, h: 4, minW: 3, maxW: 12, minH: 3, maxH: 8 },
      { w: 6, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 8 },
      { h: 5, minH: 3, maxH: 10 },
    ),
    config: recipesConfig,
  },
  shopping: {
    surfaces: ["personal", "home", "home-source"],
    sizes: sizes(
      { w: 4, h: 4, minW: 3, maxW: 12, minH: 3, maxH: 10 },
      { w: 3, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 10 },
      { h: 5, minH: 3, maxH: 10 },
    ),
    config: shoppingConfig,
  },
  "meal-planner": {
    surfaces: ["personal", "home", "home-source"],
    sizes: sizes(
      { w: 4, h: 4, minW: 3, maxW: 12, minH: 3, maxH: 10 },
      { w: 3, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 10 },
      { h: 5, minH: 3, maxH: 10 },
    ),
    config: mealPlannerConfig,
  },
  habits: {
    surfaces: ["personal", "home", "home-source"],
    sizes: habitSizes,
    config: habitsConfig,
  },
  "habit-insights": {
    surfaces: ["personal", "home", "home-source"],
    sizes: habitSizes,
    config: habitInsightsConfig,
  },
  "habit-progress": {
    surfaces: ["personal", "home", "home-source"],
    sizes: habitSizes,
    config: habitProgressConfig,
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
  readonly "chore-schedule": WidgetConfig<"chore-schedule">;
  readonly "home-vacation": WidgetConfig<"home-vacation">;
  readonly "weekly-points": WidgetConfig<"weekly-points">;
  readonly "points-leaderboard": WidgetConfig<"points-leaderboard">;
  readonly "my-points": WidgetConfig<"my-points">;
  readonly "personal-points": WidgetConfig<"personal-points">;
  readonly recipes: WidgetConfig<"recipes">;
  readonly shopping: WidgetConfig<"shopping">;
  readonly "meal-planner": WidgetConfig<"meal-planner">;
  readonly habits: WidgetConfig<"habits">;
  readonly "habit-insights": WidgetConfig<"habit-insights">;
  readonly "habit-progress": WidgetConfig<"habit-progress">;
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
