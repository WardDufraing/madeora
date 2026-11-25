import { z } from "zod";

import type { Placement } from "./geometry";
import type { DashboardLayout } from "./layout";
import { breakpoints, isWidgetType, type Breakpoint, type WidgetType } from "./widgets";

/**
 * A layout's arrangement without any widget settings (UX2c; redesign decisions 31 and 32): which
 * widgets, which are hidden, and where each sits on every screen size. Previews of templates and of
 * history versions draw only this, as labelled boxes, never widget content, so a preview never
 * reads or shows anyone's records. Client-safe.
 */
export interface LayoutPreview {
  readonly widgets: readonly {
    readonly id: string;
    readonly type: WidgetType;
    readonly hidden: boolean;
  }[];
  readonly placements: { readonly [B in Breakpoint]: readonly Placement[] };
}

export function layoutPreview(layout: DashboardLayout): LayoutPreview {
  return {
    widgets: layout.widgets.map((widget) => ({
      id: widget.id,
      type: widget.type,
      hidden: widget.hidden,
    })),
    placements: {
      lg: layout.placements.lg.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
      md: layout.placements.md.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
      sm: layout.placements.sm.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
    },
  };
}

const placementSchema = z.object({
  id: z.string(),
  x: z.int().min(0),
  y: z.int().min(0),
  w: z.int().min(1),
  h: z.int().min(1),
});

/**
 * Reads a preview from an API answer. Widget types this client does not know (a newer server) are
 * left out together with their placements, so the rest still draws.
 */
export const layoutPreviewSchema = z
  .object({
    widgets: z.array(z.object({ id: z.string(), type: z.string(), hidden: z.boolean() })),
    placements: z.object({
      lg: z.array(placementSchema),
      md: z.array(placementSchema),
      sm: z.array(placementSchema),
    }),
  })
  .transform((value): LayoutPreview => {
    const widgets = value.widgets.flatMap((widget) =>
      isWidgetType(widget.type)
        ? [{ id: widget.id, type: widget.type, hidden: widget.hidden }]
        : [],
    );
    const known = new Set(widgets.map((widget) => widget.id));
    const keep = (list: readonly Placement[]) => list.filter((p) => known.has(p.id));
    return {
      widgets,
      placements: {
        lg: keep(value.placements.lg),
        md: keep(value.placements.md),
        sm: keep(value.placements.sm),
      },
    };
  });

/** What a history version changed compared with the version before it. */
export interface VersionChange {
  readonly added: readonly WidgetType[];
  readonly removed: readonly WidgetType[];
  /** Widgets that stayed were moved, resized, hidden or shown on some screen size. */
  readonly rearranged: boolean;
}

/**
 * The contextual summary of a version (decision 32): widgets added and removed since `older` (the
 * version before it; null for the oldest one kept, which then counts as all added), and whether the
 * widgets both share were arranged differently. Widget settings are not compared: previews carry
 * none.
 */
export function versionChange(older: LayoutPreview | null, newer: LayoutPreview): VersionChange {
  if (!older) return { added: newer.widgets.map((w) => w.type), removed: [], rearranged: false };
  const olderById = new Map(older.widgets.map((w) => [w.id, w]));
  const newerById = new Map(newer.widgets.map((w) => [w.id, w]));
  const added = newer.widgets.filter((w) => !olderById.has(w.id)).map((w) => w.type);
  const removed = older.widgets.filter((w) => !newerById.has(w.id)).map((w) => w.type);
  let rearranged = newer.widgets.some((w) => {
    const before = olderById.get(w.id);
    return before !== undefined && before.hidden !== w.hidden;
  });
  for (const breakpoint of breakpoints) {
    if (rearranged) break;
    const before = new Map(older.placements[breakpoint].map((p) => [p.id, p]));
    rearranged = newer.placements[breakpoint].some((p) => {
      const was = before.get(p.id);
      return (
        was !== undefined && (was.x !== p.x || was.y !== p.y || was.w !== p.w || was.h !== p.h)
      );
    });
  }
  return { added, removed, rearranged };
}

/**
 * A name for a copy of the template `name` that none of `taken` already uses (decision 31:
 * duplicate-name handling), compared without regard to case or surrounding spaces. `format(name,
 * n)` words the n-th copy ("Morning (copy)", "Morning (copy 2)"). The original name is shortened
 * when needed so the result stays within `max` characters.
 */
export function copyName(
  name: string,
  taken: readonly string[],
  format: (name: string, n: number) => string,
  max: number,
): string {
  const used = new Set(taken.map((entry) => entry.trim().toLocaleLowerCase()));
  for (let n = 1; ; n += 1) {
    let base = name.trim();
    let candidate = format(base, n);
    while (candidate.length > max && base.length > 1) {
      base = base.slice(0, -1).trimEnd();
      candidate = format(base, n);
    }
    candidate = candidate.slice(0, max).trim();
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
