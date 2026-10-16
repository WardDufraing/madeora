import { moveElement, verticalCompactor, type LayoutItem } from "react-grid-layout/core";

import { breakpointColumns, widgetRegistry, type Breakpoint, type WidgetType } from "./widgets";

/**
 * Grid arithmetic for dashboard layouts (S17), shared by the server validator, the reader and the
 * editor's keyboard controls. Compaction and moves use React Grid Layout's own pure functions, so a
 * layout arranged with the keyboard ends up exactly where the same drag would put it.
 */

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
 * Moves one widget a step, pushing others out of the way like a drag would, then compacts. A step up
 * or down jumps past the neighbour in that direction, so "up" always changes the order.
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
  let x = target.x;
  let y = target.y;
  if (direction === "left") x = Math.max(0, x - 1);
  if (direction === "right") x = Math.min(cols - target.w, x + 1);
  if (direction === "up") {
    // The nearest widget above that shares a column: go to its top.
    const above = placements
      .filter((p) => p.id !== id && p.y < target.y && p.x < x + target.w && x < p.x + p.w)
      .reduce<Placement | null>((best, p) => (!best || p.y > best.y ? p : best), null);
    if (!above) return [...placements];
    y = above.y;
  }
  if (direction === "down") {
    const below = placements
      .filter(
        (p) => p.id !== id && p.y >= target.y + target.h && p.x < x + target.w && x < p.x + p.w,
      )
      .reduce<Placement | null>((best, p) => (!best || p.y < best.y ? p : best), null);
    if (!below) return [...placements];
    // Just under it, so it moves up into the space this widget leaves.
    y = below.y + below.h;
  }
  if (x === target.x && y === target.y) return [...placements];
  const items = toItems(placements);
  const item = items.find((i) => i.i === id);
  if (!item) return [...placements];
  const moved = moveElement(items, item, x, y, true, false, "vertical", cols);
  return compact(fromItems(moved, placements), breakpoint);
}

/** Resizes one widget a step within its bounds, pushing others down, then compacts. */
export function resizeWidget(
  placements: readonly Placement[],
  id: string,
  type: WidgetType,
  direction: ResizeDirection,
  breakpoint: Breakpoint,
): Placement[] {
  const cols = breakpointColumns[breakpoint];
  const target = placements.find((p) => p.id === id);
  if (!target) return [...placements];
  const dw = direction === "wider" ? 1 : direction === "narrower" ? -1 : 0;
  const dh = direction === "taller" ? 1 : direction === "shorter" ? -1 : 0;
  const size = clampSize(type, breakpoint, target.w + dw, target.h + dh);
  if (size.w === target.w && size.h === target.h) return [...placements];
  // Growing past the right edge moves the widget left instead.
  const x = Math.min(target.x, cols - size.w);
  const resized = placements.map((p) => (p.id === id ? { ...p, x, ...size } : p));
  // Push anything the bigger widget now covers below it.
  const items = toItems(resized);
  const item = items.find((i) => i.i === id);
  if (!item) return resized;
  const moved = moveElement(items, item, x, target.y, true, false, "vertical", cols);
  return compact(fromItems(moved, resized), breakpoint);
}

/** What a step would do, for disabling buttons that would change nothing. */
export function canMove(
  placements: readonly Placement[],
  id: string,
  direction: MoveDirection,
  breakpoint: Breakpoint,
): boolean {
  const before = placements.find((p) => p.id === id);
  const after = moveWidget(placements, id, direction, breakpoint).find((p) => p.id === id);
  return !!before && !!after && (before.x !== after.x || before.y !== after.y);
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
  return size.w !== target.w || size.h !== target.h;
}
