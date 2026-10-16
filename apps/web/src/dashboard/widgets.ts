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

/** The widgets that may be added to a dashboard, with whether each needs a source Home. */
export function catalogueFor(
  dashboard: DashboardKind,
): readonly { readonly type: WidgetType; readonly needsSource: boolean }[] {
  return widgetTypes.flatMap((type): { type: WidgetType; needsSource: boolean }[] => {
    if (surfaceFor(type, dashboard, false)) return [{ type, needsSource: false }];
    if (surfaceFor(type, dashboard, true)) return [{ type, needsSource: true }];
    return [];
  });
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
