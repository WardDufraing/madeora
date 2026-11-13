import { z } from "zod";

import { nameProblem, normalizeName } from "@/names/visible-name";

/**
 * A Household Display's own layout and presentation (S44; spec "Confirmed independent layouts for
 * each Household Display"). Client-safe and framework-free: the manager's editor, the server routes
 * and the display read it. The database checks the outer shape again
 * (`private.valid_display_layout`), and decides on its own what data each widget may show: a layout
 * can choose and arrange widgets, never widen what a display can read.
 *
 * The catalogue is only shared-display-safe widgets. Each one is arranged in order: three columns
 * in landscape, two in portrait, one on a narrow screen; its size is how many columns (and rows) it
 * spans, so a layout never clips and always has a predictable fallback.
 */

export const DISPLAY_LAYOUT_VERSION = 1;
/** Same limits as the database. */
export const MAX_DISPLAY_WIDGETS = 8;
export const MAX_SHOPPING_LISTS = 5;
export const LOCK_MESSAGE_MAX = 80;

export const displayWidgetTypes = ["clock", "chores", "shopping"] as const;
export type DisplayWidgetType = (typeof displayWidgetTypes)[number];

export const displayWidgetSizes = ["small", "medium", "large"] as const;
export type DisplayWidgetSize = (typeof displayWidgetSizes)[number];

export const displayCounts = [5, 10, 15] as const;
const count = z.union([z.literal(5), z.literal(10), z.literal(15)]).default(10);

export const displayWidgetConfigs = {
  clock: z.strictObject({ showDate: z.boolean().default(true) }),
  /** `actions: false` makes the widget read-only: the server then refuses member actions too. */
  chores: z.strictObject({ actions: z.boolean().default(true), count }),
  /** No lists chosen: all of the Home's active lists, in their order. */
  shopping: z.strictObject({
    listIds: z.array(z.uuid()).max(MAX_SHOPPING_LISTS).default([]),
    count,
  }),
} as const;

export type DisplayWidgetConfig<T extends DisplayWidgetType> = z.output<
  (typeof displayWidgetConfigs)[T]
>;

export type DisplayWidget = {
  [T in DisplayWidgetType]: {
    readonly id: string;
    readonly type: T;
    readonly size: DisplayWidgetSize;
    readonly config: DisplayWidgetConfig<T>;
  };
}[DisplayWidgetType];

export interface DisplayLayout {
  readonly version: typeof DISPLAY_LAYOUT_VERSION;
  readonly widgets: readonly DisplayWidget[];
}

export const displayOrientations = ["auto", "landscape", "portrait"] as const;
export const displayThemes = ["auto", "light", "dark"] as const;
export const displayDensities = ["comfortable", "compact"] as const;
export const displayClockFormats = ["auto", "12h", "24h"] as const;

export const displayPreferencesSchema = z.strictObject({
  orientation: z.enum(displayOrientations),
  theme: z.enum(displayThemes),
  density: z.enum(displayDensities),
  clockFormat: z.enum(displayClockFormats),
});
export type DisplayPreferences = z.infer<typeof displayPreferencesSchema>;

export const defaultDisplayPreferences: DisplayPreferences = {
  orientation: "auto",
  theme: "auto",
  density: "comfortable",
  clockFormat: "auto",
};

/** The layout a display starts with, and gets back on Restore defaults (stored as `null`). */
export const defaultDisplayLayout: DisplayLayout = {
  version: DISPLAY_LAYOUT_VERSION,
  widgets: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      type: "clock",
      size: "medium",
      config: { showDate: true },
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      type: "chores",
      size: "large",
      config: { actions: true, count: 10 },
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      type: "shopping",
      size: "medium",
      config: { listIds: [], count: 10 },
    },
  ],
};

const widgetShapeSchema = z.strictObject({
  id: z.uuid(),
  type: z.string().max(32),
  size: z.enum(displayWidgetSizes),
  config: z.record(z.string().max(32), z.unknown()),
});

const layoutShapeSchema = z.strictObject({
  version: z.literal(DISPLAY_LAYOUT_VERSION),
  widgets: z.array(widgetShapeSchema).max(MAX_DISPLAY_WIDGETS),
});

function isDisplayWidgetType(value: string): value is DisplayWidgetType {
  return (displayWidgetTypes as readonly string[]).includes(value);
}

function parseWidget(raw: z.infer<typeof widgetShapeSchema>): DisplayWidget | null {
  if (!isDisplayWidgetType(raw.type)) return null;
  switch (raw.type) {
    case "clock": {
      const config = displayWidgetConfigs.clock.safeParse(raw.config);
      return config.success
        ? { id: raw.id, type: "clock", size: raw.size, config: config.data }
        : null;
    }
    case "chores": {
      const config = displayWidgetConfigs.chores.safeParse(raw.config);
      return config.success
        ? { id: raw.id, type: "chores", size: raw.size, config: config.data }
        : null;
    }
    case "shopping": {
      const config = displayWidgetConfigs.shopping.safeParse(raw.config);
      if (!config.success || new Set(config.data.listIds).size !== config.data.listIds.length) {
        return null;
      }
      return { id: raw.id, type: "shopping", size: raw.size, config: config.data };
    }
  }
}

/**
 * Every rule a saved layout must meet (the manager's save). `null`: it does not; the server then
 * refuses the save.
 */
export function checkDisplayLayout(input: unknown): DisplayLayout | null {
  const parsed = layoutShapeSchema.safeParse(input);
  if (!parsed.success) return null;
  const ids = new Set<string>();
  const widgets: DisplayWidget[] = [];
  for (const raw of parsed.data.widgets) {
    if (ids.has(raw.id)) return null;
    ids.add(raw.id);
    const widget = parseWidget(raw);
    if (!widget) return null;
    widgets.push(widget);
  }
  return { version: DISPLAY_LAYOUT_VERSION, widgets };
}

/**
 * The layout a display shows from what the database holds: `null` is the default layout, and a
 * widget that is not (or no longer) understood is left out instead of failing the whole screen.
 */
export function readDisplayLayout(stored: unknown): DisplayLayout {
  if (stored === null || stored === undefined) return defaultDisplayLayout;
  const parsed = z
    .strictObject({
      version: z.literal(DISPLAY_LAYOUT_VERSION),
      widgets: z.array(z.unknown()).max(MAX_DISPLAY_WIDGETS),
    })
    .safeParse(stored);
  if (!parsed.success) return defaultDisplayLayout;
  const ids = new Set<string>();
  const widgets: DisplayWidget[] = [];
  for (const item of parsed.data.widgets) {
    const raw = widgetShapeSchema.safeParse(item);
    if (!raw.success || ids.has(raw.data.id)) continue;
    const widget = parseWidget(raw.data);
    if (!widget) continue;
    ids.add(widget.id);
    widgets.push(widget);
  }
  return { version: DISPLAY_LAYOUT_VERSION, widgets };
}

/** A new widget of `type` with its default settings. */
export function newDisplayWidget(type: DisplayWidgetType, id: string): DisplayWidget {
  switch (type) {
    case "clock":
      return { id, type, size: "medium", config: displayWidgetConfigs.clock.parse({}) };
    case "chores":
      return { id, type, size: "large", config: displayWidgetConfigs.chores.parse({}) };
    case "shopping":
      return { id, type, size: "medium", config: displayWidgetConfigs.shopping.parse({}) };
  }
}

/** Whether the layout offers member actions (the same rule as `private.display_actions_enabled`). */
export function layoutOffersActions(layout: DisplayLayout): boolean {
  return layout.widgets.some((widget) => widget.type === "chores" && widget.config.actions);
}

/** Columns the display arranges its widgets in. */
export function displayColumns(orientation: "landscape" | "portrait"): number {
  return orientation === "landscape" ? 3 : 2;
}

/**
 * The cells a widget of `size` takes in a grid of `columns`: small one cell, medium two columns
 * (all of a narrower grid) and two rows, large the full width and two rows.
 */
export function widgetSpan(
  size: DisplayWidgetSize,
  columns: number,
): { readonly columns: number; readonly rows: number } {
  if (size === "small") return { columns: 1, rows: 1 };
  if (size === "medium") return { columns: Math.min(2, columns), rows: 2 };
  return { columns, rows: 2 };
}

export interface DisplayPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Where each widget lands on a display with `columns` columns: the same "dense" auto-placement the
 * display's CSS grid uses (each widget, in order, takes the first free spot from the top-left where
 * its span fits), so the editor's drag-and-drop preview shows exactly what the display will show.
 */
export function placeDisplayWidgets(
  widgets: readonly Pick<DisplayWidget, "id" | "size">[],
  columns: number,
): DisplayPlacement[] {
  const taken = new Set<string>();
  const free = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1)
        if (taken.has(String(x + dx) + ":" + String(y + dy))) return false;
    }
    return true;
  };
  return widgets.map((widget) => {
    const { columns: w, rows: h } = widgetSpan(widget.size, columns);
    for (let y = 0; ; y += 1) {
      for (let x = 0; x + w <= columns; x += 1) {
        if (!free(x, y, w, h)) continue;
        for (let dy = 0; dy < h; dy += 1) {
          for (let dx = 0; dx < w; dx += 1) taken.add(String(x + dx) + ":" + String(y + dy));
        }
        return { id: widget.id, x, y, w, h };
      }
    }
  });
}

/**
 * The widget order after a drag: top to bottom, then left to right by where each widget was
 * dropped, so the display's own placement puts them back in the arrangement the person sees.
 */
export function orderFromPlacements<T extends { readonly id: string }>(
  widgets: readonly T[],
  placements: readonly { readonly i: string; readonly x: number; readonly y: number }[],
): T[] {
  const at = new Map(placements.map((item) => [item.i, item]));
  const index = new Map(widgets.map((widget, position) => [widget.id, position]));
  return [...widgets].sort((a, b) => {
    const pa = at.get(a.id);
    const pb = at.get(b.id);
    if (!pa || !pb) return (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
    return pa.y - pb.y || pa.x - pb.x || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
  });
}

/** The lock screen's welcome message: the visible-text rule, like the database; empty is none. */
export const lockMessageSchema = z
  .string()
  .max(1000)
  .transform((value, context) => {
    const text = normalizeName(value);
    if (text === "") return null;
    if (nameProblem(text, LOCK_MESSAGE_MAX)) {
      context.addIssue({ code: "custom", message: "messageInvalid" });
      return z.NEVER;
    }
    return text;
  });
