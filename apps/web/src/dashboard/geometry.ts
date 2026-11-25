import { verticalCompactor, type LayoutItem } from "react-grid-layout/core";

import { breakpointColumns, widgetRegistry, type Breakpoint, type WidgetType } from "./widgets";

/**
 * Grid arithmetic for dashboard layouts (S17, UX2b), shared by the server validator, the reader and
 * the editor. Desktop and tablet keep the gaps people leave and move only widgets that would
 * overlap (`reflow`); the editor's drag and resize use the same `reflow`, so a layout arranged with
 * the keyboard ends up exactly where the same drag would put it. The phone layout is a stacked list,
 * compacted with React Grid Layout's own vertical compactor.
 */

/** Rows per breakpoint (the brief's limit; the server validator refuses a layout past it). */
export const MAX_ROWS = 200;

export interface Placement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function overlaps(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether any two placements share a cell. */
export function hasOverlap(placements: readonly Placement[]): boolean {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i];
      const b = placements[j];
      if (a && b && overlaps(a, b)) return true;
    }
  }
  return false;
}

function toItems(placements: readonly Placement[]): LayoutItem[] {
  return placements.map(({ id, x, y, w, h }) => ({ i: id, x, y, w, h }));
}

function fromItems(items: readonly LayoutItem[], order: readonly Placement[]): Placement[] {
  const byId = new Map(items.map((item) => [item.i, item]));
  return order.flatMap((p) => {
    const item = byId.get(p.id);
    return item ? [{ id: p.id, x: item.x, y: item.y, w: item.w, h: item.h }] : [];
  });
}

/** Moves every widget up as far as it goes without overlapping (React Grid Layout's default). */
export function compact(placements: readonly Placement[], breakpoint: Breakpoint): Placement[] {
  return fromItems(
    verticalCompactor.compact(toItems(placements), breakpointColumns[breakpoint]),
    placements,
  );
}

/** Keeps a size inside the type's bounds and the grid. */
export function clampSize(
  type: WidgetType,
  breakpoint: Breakpoint,
  w: number,
  h: number,
): { readonly w: number; readonly h: number } {
  const bounds = widgetRegistry[type].sizes[breakpoint];
  const cols = breakpointColumns[breakpoint];
  return {
    w: Math.min(Math.max(w, bounds.minW), bounds.maxW, cols),
    h: Math.min(Math.max(h, bounds.minH), bounds.maxH),
  };
}

/** Whether every placement ends within `MAX_ROWS` (S17-L1). */
export function fitsRows(placements: readonly Placement[]): boolean {
  return placements.every((p) => p.y + p.h <= MAX_ROWS);
}

/** Where a new widget of `type` goes: below everything, at the start of the row. */
export function placeNew(
  placements: readonly Placement[],
  id: string,
  type: WidgetType,
  breakpoint: Breakpoint,
): Placement[] {
  const bounds = widgetRegistry[type].sizes[breakpoint];
  const bottom = placements.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  const size = clampSize(type, breakpoint, bounds.w, bounds.h);
  return [...placements, { id, x: 0, y: bottom, ...size }];
}

export type MoveDirection = "up" | "down" | "left" | "right";
export type ResizeDirection = "wider" | "narrower" | "taller" | "shorter";

/**
 * Whether a breakpoint keeps the gaps people leave (UX2b; Ward, 2026-11-25: "keep gaps"). The
 * desktop and tablet grids keep every widget where it was put; only widgets that would overlap move.
 * The one-column phone layout is a list, so it always stacks without gaps.
 */
export function keepsGaps(breakpoint: Breakpoint): boolean {
  return breakpoint !== "sm";
}

function byPosition(a: Placement, b: Placement): number {
  return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Smart reflow (UX2b; redesign decision 5). `fixed` are placed exactly as given (they must not
 * overlap each other); every other widget keeps its position unless it overlaps something already
 * placed, in which case it moves straight down just far enough, which may in turn move what is
 * under it. Widgets are settled top to bottom (then start to end, then by id), so the same action
 * always gives the same result, nothing overlaps, and nothing that does not have to move moves.
 */
export function reflow(placements: readonly Placement[], fixed: readonly Placement[]): Placement[] {
  const fixedIds = new Set(fixed.map((p) => p.id));
  const placed: Placement[] = [...fixed];
  const rest = placements.filter((p) => !fixedIds.has(p.id)).sort(byPosition);
  for (const p of rest) {
    let candidate = p;
    for (;;) {
      const hits = placed.filter((other) => overlaps(candidate, other));
      if (hits.length === 0) break;
      const below = hits.reduce((max, other) => Math.max(max, other.y + other.h), 0);
      candidate = { ...candidate, y: below };
    }
    placed.push(candidate);
  }
  // The caller's order, so a reflow never reorders the stored array.
  const result = new Map(placed.map((p) => [p.id, p]));
  return placements.flatMap((p) => {
    const next = result.get(p.id);
    return next ? [next] : [];
  });
}

/**
 * The placements after one widget is put at `rect`: on the desktop and tablet grids, a reflow;
 * on the phone, the same move followed by compaction (the phone layout is a stacked list).
 */
export function placeWidget(
  placements: readonly Placement[],
  rect: Placement,
  breakpoint: Breakpoint,
): Placement[] {
  const cols = breakpointColumns[breakpoint];
  const w = Math.min(rect.w, cols);
  const clamped = {
    ...rect,
    w,
    x: Math.min(Math.max(rect.x, 0), cols - w),
    y: Math.max(rect.y, 0),
  };
  const next = reflow(placements, [clamped]);
  return keepsGaps(breakpoint) ? next : compact(next, breakpoint);
}

/** The phone list in a new order, stacked from the top. */
function restack(placements: readonly Placement[], order: readonly string[]): Placement[] {
  const byId = new Map(placements.map((p) => [p.id, p]));
  const ys = new Map<string, number>();
  let y = 0;
  for (const id of order) {
    const p = byId.get(id);
    if (!p) continue;
    ys.set(id, y);
    y += p.h;
  }
  return placements.map((p) => ({ ...p, x: 0, y: ys.get(p.id) ?? p.y }));
}

/** The phone list's order: top to bottom. */
export function stackOrder(placements: readonly Placement[]): string[] {
  return [...placements].sort(byPosition).map((p) => p.id);
}

/** Moves a widget one place up or down in the phone list (decision 30's list editing). */
export function moveInStack(
  placements: readonly Placement[],
  id: string,
  direction: "up" | "down",
): Placement[] {
  const order = stackOrder(placements);
  const index = order.indexOf(id);
  const other = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || other < 0 || other >= order.length) return [...placements];
  const next = [...order];
  next[index] = order[other] ?? id;
  next[other] = id;
  return restack(placements, next);
}

/** Whether no other widget covers any column of `columns` (x, w) on `row`. */
function rowFree(
  placements: readonly Placement[],
  id: string,
  row: number,
  x: number,
  w: number,
): boolean {
  return !placements.some(
    (p) => p.id !== id && p.y <= row && row < p.y + p.h && p.x < x + w && x < p.x + p.w,
  );
}

/**
 * Moves one widget a step with the keyboard or the move buttons. Left and right shift one column.
 * Up and down move one row while that row is free; when a widget is directly in the way, they swap
 * places with it (and with any other widget on that row in the same columns), so a step always
 * changes the order. Anything else moves only if it would overlap (decision 5). On the phone the
 * list stays stacked.
 */
export function moveWidget(
  placements: readonly Placement[],
  id: string,
  direction: MoveDirection,
  breakpoint: Breakpoint,
): Placement[] {
  const cols = breakpointColumns[breakpoint];
  const target = placements.find((p) => p.id === id);
  if (!target) return [...placements];
  const { x, y, w, h } = target;
  if (!keepsGaps(breakpoint)) {
    return direction === "up" || direction === "down"
      ? moveInStack(placements, id, direction)
      : [...placements];
  }
  if (direction === "left" || direction === "right") {
    const nx = direction === "left" ? Math.max(0, x - 1) : Math.min(cols - w, x + 1);
    if (nx === x) return [...placements];
    return placeWidget(placements, { ...target, x: nx }, breakpoint);
  }
  if (direction === "up") {
    if (y === 0) return [...placements];
    if (rowFree(placements, id, y - 1, x, w)) {
      return placeWidget(placements, { ...target, y: y - 1 }, breakpoint);
    }
    // Swap with what is directly above: go to its top; it is pushed below.
    const above = placements.filter(
      (p) => p.id !== id && p.y < y && y - 1 < p.y + p.h && p.x < x + w && x < p.x + p.w,
    );
    if (above.length === 0) return [...placements];
    const top = above.reduce((min, p) => Math.min(min, p.y), Infinity);
    return placeWidget(placements, { ...target, y: top }, breakpoint);
  }
  // Down.
  const below = placements.filter(
    (p) => p.id !== id && p.y <= y + h && y + h < p.y + p.h && p.x < x + w && x < p.x + p.w,
  );
  if (below.length === 0) return placeWidget(placements, { ...target, y: y + 1 }, breakpoint);
  // Swap: what is directly below moves up into this widget's place, this widget goes under it.
  const tallest = below.reduce((max, p) => Math.max(max, p.h), 0);
  const raised = below.map((p) => ({ ...p, y: p.y - h }));
  return reflow(placements, [...raised, { ...target, y: y + tallest }]);
}

/**
 * Resizes one widget a step within its bounds. A widget that grows pushes only what it would now
 * overlap; a widget that shrinks leaves the space free (decision 5 and "keep gaps"). Growing past
 * the right edge moves the widget left instead.
 */
export function resizeWidget(
  placements: readonly Placement[],
  id: string,
  type: WidgetType,
  direction: ResizeDirection,
  breakpoint: Breakpoint,
): Placement[] {
  const target = placements.find((p) => p.id === id);
  if (!target) return [...placements];
  const dw = direction === "wider" ? 1 : direction === "narrower" ? -1 : 0;
  const dh = direction === "taller" ? 1 : direction === "shorter" ? -1 : 0;
  return setSize(placements, id, type, target.w + dw, target.h + dh, breakpoint);
}

/** Gives one widget a size (clamped to its bounds and the grid), reflowing as `resizeWidget`. */
export function setSize(
  placements: readonly Placement[],
  id: string,
  type: WidgetType,
  w: number,
  h: number,
  breakpoint: Breakpoint,
): Placement[] {
  const cols = breakpointColumns[breakpoint];
  const target = placements.find((p) => p.id === id);
  if (!target) return [...placements];
  const size = clampSize(type, breakpoint, w, h);
  if (size.w === target.w && size.h === target.h) return [...placements];
  const x = Math.min(target.x, cols - size.w);
  return placeWidget(placements, { ...target, x, ...size }, breakpoint);
}

/**
 * Overlaps resolved without closing gaps on the desktop and tablet grids (each widget keeps its
 * position unless it overlaps one above it), compacted on the phone. Used by the reader, so a stored
 * layout keeps the arrangement its owner chose.
 */
export function settle(placements: readonly Placement[], breakpoint: Breakpoint): Placement[] {
  return keepsGaps(breakpoint) ? reflow(placements, []) : compact(placements, breakpoint);
}

export type SizePresetId = "small" | "medium" | "large" | "wide";

export interface SizePreset {
  readonly id: SizePresetId;
  readonly w: number;
  readonly h: number;
}

/**
 * Named sizes a widget type offers at a breakpoint (redesign decision 4), derived from its bounds:
 * Small (its minimum), Medium (its default), Large (half as wide again and two rows taller, within
 * bounds) and Wide (the full width the type allows, default height). Sizes that coincide are
 * offered once, under the first name; the phone has no Wide.
 */
export function sizePresets(type: WidgetType, breakpoint: Breakpoint): SizePreset[] {
  const bounds = widgetRegistry[type].sizes[breakpoint];
  const cols = breakpointColumns[breakpoint];
  const candidates: SizePreset[] = [
    { id: "small", ...clampSize(type, breakpoint, bounds.minW, bounds.minH) },
    { id: "medium", ...clampSize(type, breakpoint, bounds.w, bounds.h) },
    {
      id: "large",
      ...clampSize(type, breakpoint, Math.ceil(bounds.w * 1.5), bounds.h + 2),
    },
  ];
  if (cols > 1) {
    candidates.push({ id: "wide", ...clampSize(type, breakpoint, cols, bounds.h) });
  }
  const seen = new Set<string>();
  return candidates.filter((preset) => {
    const key = `${String(preset.w)}x${String(preset.h)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface Slot {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Free areas inside the arrangement where "Add widget here" is offered in edit mode (decision 3):
 * gaps above the lowest widget, at least `minWidth` columns wide, each as wide and tall as the gap
 * allows from its top-left cell (scanned top to bottom, start to end, never overlapping another
 * slot). The phone layout has no gaps.
 */
export function emptySlots(
  placements: readonly Placement[],
  breakpoint: Breakpoint,
  minWidth = 2,
): Slot[] {
  if (!keepsGaps(breakpoint)) return [];
  const cols = breakpointColumns[breakpoint];
  const bottom = placements.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  const taken = (x: number, y: number, slots: readonly Slot[]) =>
    placements.some((p) => p.x <= x && x < p.x + p.w && p.y <= y && y < p.y + p.h) ||
    slots.some((s) => s.x <= x && x < s.x + s.w && s.y <= y && y < s.y + s.h);
  const slots: Slot[] = [];
  for (let y = 0; y < bottom; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (taken(x, y, slots)) continue;
      let w = 0;
      while (x + w < cols && !taken(x + w, y, slots)) w += 1;
      if (w < minWidth) {
        x += w;
        continue;
      }
      let h = 1;
      while (y + h < bottom) {
        let rowOpen = true;
        for (let dx = 0; dx < w; dx += 1) {
          if (taken(x + dx, y + h, slots)) rowOpen = false;
        }
        if (!rowOpen) break;
        h += 1;
      }
      slots.push({ x, y, w, h });
      x += w - 1;
    }
  }
  return slots;
}

/**
 * Where a widget of `type` goes when added at a free slot: its default size, as narrow as the slot
 * when it can be (never below its minimum), at the slot's top-left; whatever it then overlaps moves
 * down (decision 5).
 */
export function placeInSlot(
  placements: readonly Placement[],
  id: string,
  type: WidgetType,
  slot: Slot,
  breakpoint: Breakpoint,
): Placement[] {
  const bounds = widgetRegistry[type].sizes[breakpoint];
  const size = clampSize(type, breakpoint, Math.min(bounds.w, slot.w), bounds.h);
  return placeWidget(
    [...placements, { id, x: slot.x, y: slot.y, ...size }],
    {
      id,
      x: slot.x,
      y: slot.y,
      ...size,
    },
    breakpoint,
  );
}

/** What a step would do, for disabling buttons that would change nothing. */
export function canMove(
  placements: readonly Placement[],
  id: string,
  direction: MoveDirection,
  breakpoint: Breakpoint,
): boolean {
  const before = placements.find((p) => p.id === id);
  const next = moveWidget(placements, id, direction, breakpoint);
  const after = next.find((p) => p.id === id);
  return !!before && !!after && (before.x !== after.x || before.y !== after.y) && fitsRows(next);
}

export function canResize(
  placements: readonly Placement[],
  id: string,
  type: WidgetType,
  direction: ResizeDirection,
  breakpoint: Breakpoint,
): boolean {
  const target = placements.find((p) => p.id === id);
  if (!target) return false;
  const dw = direction === "wider" ? 1 : direction === "narrower" ? -1 : 0;
  const dh = direction === "taller" ? 1 : direction === "shorter" ? -1 : 0;
  const size = clampSize(type, breakpoint, target.w + dw, target.h + dh);
  if (size.w === target.w && size.h === target.h) return false;
  // A step that would push something past the last row is refused, like the server does.
  return fitsRows(resizeWidget(placements, id, type, direction, breakpoint));
}
