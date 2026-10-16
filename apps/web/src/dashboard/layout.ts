import { z } from "zod";

import { compact, hasOverlap, placeNew, type Placement } from "./geometry";
import {
  breakpointColumns,
  breakpoints,
  defaultConfig,
  isWidgetType,
  parseConfig,
  surfaceFor,
  widgetRegistry,
  type Breakpoint,
  type DashboardKind,
  type WidgetType,
} from "./widgets";

/**
 * The dashboard layout contract, schema version 1 (S17; architecture.md §15). Client-safe, and
 * stable for later mobile clients. The server checks every saved layout with `checkLayout`; the
 * database checks only its outer shape and size, so readers use `readLayout`, which keeps what it
 * recognises and drops the rest instead of failing the whole dashboard.
 */

export const LAYOUT_VERSION = 1;
/** Same limits as the brief: widgets per dashboard, rows per breakpoint. */
export const MAX_WIDGETS = 40;
export const MAX_ROWS = 200;

export interface DashboardWidget {
  readonly id: string;
  readonly type: WidgetType;
  /** Hidden widgets keep their place and settings, and show only in edit mode. */
  readonly hidden: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  /** Only on the personal dashboard: the Home this widget shows (spec: selected Home widgets). */
  readonly source?: { readonly homeId: string };
}

export interface DashboardLayout {
  readonly version: typeof LAYOUT_VERSION;
  readonly widgets: readonly DashboardWidget[];
  readonly placements: { readonly [B in Breakpoint]: readonly Placement[] };
}

const placementSchema = z.strictObject({
  id: z.uuid(),
  x: z.int().min(0),
  y: z.int().min(0).max(MAX_ROWS),
  w: z.int().min(1),
  h: z.int().min(1),
});

const widgetSchema = z.strictObject({
  id: z.uuid(),
  type: z.string().max(64),
  hidden: z.boolean(),
  config: z.record(z.string().max(64), z.unknown()),
  source: z.strictObject({ homeId: z.uuid() }).optional(),
});

/** The outer shape; `checkLayout` adds every rule that needs the registry or the context. */
export const layoutShapeSchema = z.strictObject({
  version: z.literal(LAYOUT_VERSION),
  widgets: z.array(widgetSchema).max(MAX_WIDGETS),
  placements: z.strictObject({
    lg: z.array(placementSchema).max(MAX_WIDGETS),
    md: z.array(placementSchema).max(MAX_WIDGETS),
    sm: z.array(placementSchema).max(MAX_WIDGETS),
  }),
});

export interface LayoutContext {
  readonly dashboard: DashboardKind;
  /**
   * Homes a personal widget may be bound to: the person's current memberships, plus any Home already
   * bound in their saved layout (so a widget whose Home they left can stay until they remove it,
   * shown as unavailable). Ignored for Home dashboards, which never carry a source.
   */
  readonly allowedSourceHomeIds: ReadonlySet<string>;
}

export type LayoutIssue =
  | "shape"
  | "duplicate-id"
  | "unknown-type"
  | "surface"
  | "source"
  | "config"
  | "placement-missing"
  | "placement-unknown"
  | "bounds"
  | "size"
  | "overlap";

export type LayoutCheck =
  | { readonly ok: true; readonly layout: DashboardLayout }
  | { readonly ok: false; readonly issue: LayoutIssue };

/** Every rule a saved layout must meet. The first broken rule is reported. */
export function checkLayout(input: unknown, context: LayoutContext): LayoutCheck {
  const parsed = layoutShapeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issue: "shape" };
  const seen = new Set<string>();
  const widgets: DashboardWidget[] = [];
  for (const widget of parsed.data.widgets) {
    if (seen.has(widget.id)) return { ok: false, issue: "duplicate-id" };
    seen.add(widget.id);
    if (!isWidgetType(widget.type)) return { ok: false, issue: "unknown-type" };
    if (!surfaceFor(widget.type, context.dashboard, widget.source !== undefined)) {
      return { ok: false, issue: "surface" };
    }
    if (widget.source && !context.allowedSourceHomeIds.has(widget.source.homeId)) {
      return { ok: false, issue: "source" };
    }
    const config = parseConfig(widget.type, widget.config);
    if (!config) return { ok: false, issue: "config" };
    widgets.push({
      id: widget.id,
      type: widget.type,
      hidden: widget.hidden,
      config,
      ...(widget.source ? { source: { homeId: widget.source.homeId } } : {}),
    });
  }
  const types = new Map(widgets.map((w) => [w.id, w.type]));
  for (const breakpoint of breakpoints) {
    const placements = parsed.data.placements[breakpoint];
    const placed = new Set<string>();
    for (const p of placements) {
      const type = types.get(p.id);
      if (!type) return { ok: false, issue: "placement-unknown" };
      if (placed.has(p.id)) return { ok: false, issue: "duplicate-id" };
      placed.add(p.id);
      if (p.x + p.w > breakpointColumns[breakpoint] || p.y + p.h > MAX_ROWS) {
        return { ok: false, issue: "bounds" };
      }
      const bounds = widgetRegistry[type].sizes[breakpoint];
      if (p.w < bounds.minW || p.w > bounds.maxW || p.h < bounds.minH || p.h > bounds.maxH) {
        return { ok: false, issue: "size" };
      }
    }
    if (placed.size !== widgets.length) return { ok: false, issue: "placement-missing" };
    if (hasOverlap(placements)) return { ok: false, issue: "overlap" };
  }
  return {
    ok: true,
    layout: {
      version: LAYOUT_VERSION,
      widgets,
      placements: {
        lg: parsed.data.placements.lg,
        md: parsed.data.placements.md,
        sm: parsed.data.placements.sm,
      },
    },
  };
}

/**
 * A stored layout as the dashboard can show it. Widgets of an unknown type, on the wrong surface or
 * with broken settings are dropped (settings that no longer parse fall back to defaults); missing or
 * out-of-bounds placements are rebuilt; overlaps are resolved by compaction. `dropped` says whether
 * anything had to be left out, so the page can say so instead of hiding it.
 */
export function readLayout(
  input: unknown,
  dashboard: DashboardKind,
): { readonly layout: DashboardLayout; readonly dropped: boolean } {
  const parsed = layoutShapeSchema.safeParse(input);
  if (!parsed.success) return { layout: emptyLayout(), dropped: true };
  let dropped = false;
  const seen = new Set<string>();
  const widgets: DashboardWidget[] = [];
  for (const widget of parsed.data.widgets) {
    if (
      seen.has(widget.id) ||
      !isWidgetType(widget.type) ||
      !surfaceFor(widget.type, dashboard, widget.source !== undefined)
    ) {
      dropped = true;
      continue;
    }
    seen.add(widget.id);
    widgets.push({
      id: widget.id,
      type: widget.type,
      hidden: widget.hidden,
      config: parseConfig(widget.type, widget.config) ?? defaultConfig(widget.type),
      ...(widget.source ? { source: { homeId: widget.source.homeId } } : {}),
    });
  }
  const types = new Map(widgets.map((w) => [w.id, w.type]));
  const placements = Object.fromEntries(
    breakpoints.map((breakpoint) => {
      const cols = breakpointColumns[breakpoint];
      const kept: Placement[] = [];
      const placed = new Set<string>();
      for (const p of parsed.data.placements[breakpoint]) {
        const type = types.get(p.id);
        if (!type || placed.has(p.id)) continue;
        const bounds = widgetRegistry[type].sizes[breakpoint];
        const w = Math.min(Math.max(p.w, bounds.minW), bounds.maxW, cols);
        const h = Math.min(Math.max(p.h, bounds.minH), bounds.maxH);
        kept.push({ id: p.id, x: Math.min(p.x, cols - w), y: p.y, w, h });
        placed.add(p.id);
      }
      let result = compact(kept, breakpoint);
      for (const widget of widgets) {
        if (!placed.has(widget.id)) result = placeNew(result, widget.id, widget.type, breakpoint);
      }
      return [breakpoint, compact(result, breakpoint)];
    }),
  ) as { [B in Breakpoint]: Placement[] };
  return { layout: { version: LAYOUT_VERSION, widgets, placements }, dropped };
}

export function emptyLayout(): DashboardLayout {
  return { version: LAYOUT_VERSION, widgets: [], placements: { lg: [], md: [], sm: [] } };
}

/** Adds a widget at the bottom of every breakpoint. */
export function addWidget(layout: DashboardLayout, widget: DashboardWidget): DashboardLayout {
  return {
    ...layout,
    widgets: [...layout.widgets, widget],
    placements: {
      lg: placeNew(layout.placements.lg, widget.id, widget.type, "lg"),
      md: placeNew(layout.placements.md, widget.id, widget.type, "md"),
      sm: placeNew(layout.placements.sm, widget.id, widget.type, "sm"),
    },
  };
}

/** Removes a widget everywhere and closes the gap it leaves. */
export function removeWidget(layout: DashboardLayout, id: string): DashboardLayout {
  const without = (breakpoint: Breakpoint) =>
    compact(
      layout.placements[breakpoint].filter((p) => p.id !== id),
      breakpoint,
    );
  return {
    ...layout,
    widgets: layout.widgets.filter((w) => w.id !== id),
    placements: { lg: without("lg"), md: without("md"), sm: without("sm") },
  };
}

/**
 * The visible widgets' placements for normal use: hidden widgets are left out and the rest move up
 * into the space, so hiding never leaves a hole.
 */
export function visiblePlacements(layout: DashboardLayout, breakpoint: Breakpoint): Placement[] {
  const visible = new Set(layout.widgets.filter((w) => !w.hidden).map((w) => w.id));
  return compact(
    layout.placements[breakpoint].filter((p) => visible.has(p.id)),
    breakpoint,
  );
}

/** Home ids bound by personal widgets. */
export function sourceHomeIds(layout: DashboardLayout): Set<string> {
  return new Set(layout.widgets.flatMap((w) => (w.source ? [w.source.homeId] : [])));
}

/**
 * A template's copy of a layout for a dashboard of `kind`: new widget ids (a template applied twice
 * never shares ids), and, for personal templates, no Home-bound widgets (a template must not carry a
 * binding to a Home the next person may not belong to).
 */
export function templateCopy(
  layout: DashboardLayout,
  newId: () => string,
): { readonly layout: DashboardLayout; readonly dropped: number } {
  let result = emptyLayout();
  const ids = new Map<string, string>();
  let dropped = 0;
  for (const widget of layout.widgets) {
    if (widget.source) {
      dropped += 1;
      continue;
    }
    const id = newId();
    ids.set(widget.id, id);
    result = { ...result, widgets: [...result.widgets, { ...widget, id }] };
  }
  const remap = (breakpoint: Breakpoint) =>
    layout.placements[breakpoint].flatMap((p) => {
      const id = ids.get(p.id);
      return id ? [{ ...p, id }] : [];
    });
  result = {
    ...result,
    placements: {
      lg: compact(remap("lg"), "lg"),
      md: compact(remap("md"), "md"),
      sm: compact(remap("sm"), "sm"),
    },
  };
  return { layout: result, dropped };
}
