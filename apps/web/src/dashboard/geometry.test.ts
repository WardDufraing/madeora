import { describe, expect, it } from "vitest";

import {
  emptySlots,
  hasOverlap,
  moveInStack,
  moveWidget,
  placeInSlot,
  placeWidget,
  reflow,
  setSize,
  settle,
  sizePresets,
  stackOrder,
  type Placement,
} from "./geometry";
import { widgetRegistry, widgetTypes } from "./widgets";

const p = (id: string, x: number, y: number, w: number, h: number): Placement => ({
  id,
  x,
  y,
  w,
  h,
});

/** Two side-by-side widgets on top, one full-width widget under them, one gap row, one more. */
const board: Placement[] = [
  p("a", 0, 0, 6, 2),
  p("b", 6, 0, 6, 2),
  p("c", 0, 2, 12, 2),
  p("d", 0, 5, 4, 2),
];

function at(placements: readonly Placement[], id: string): Placement | undefined {
  return placements.find((item) => item.id === id);
}

describe("reflow (decision 5: only colliding widgets move)", () => {
  it("leaves every widget that does not overlap where it is", () => {
    const moved = reflow(board, [p("a", 0, 0, 6, 2)]);
    expect(moved).toEqual(board);
  });

  it("pushes only what overlaps, just far enough, cascading downwards", () => {
    // a grows to 3 rows: c is in the way and moves down one row; d is not touched (the gap row
    // absorbs it).
    const grown = reflow(board, [p("a", 0, 0, 6, 3)]);
    expect(at(grown, "c")).toMatchObject({ y: 3 });
    expect(at(grown, "b")).toEqual(at(board, "b"));
    expect(at(grown, "d")).toEqual(at(board, "d"));
    expect(hasOverlap(grown)).toBe(false);
    // Two rows taller: c moves to 4 and now pushes d.
    const taller = reflow(board, [p("a", 0, 0, 6, 4)]);
    expect(at(taller, "c")).toMatchObject({ y: 4 });
    expect(at(taller, "d")).toMatchObject({ y: 6 });
    expect(hasOverlap(taller)).toBe(false);
  });

  it("keeps the caller's array order and is deterministic", () => {
    const once = reflow(board, [p("d", 2, 0, 4, 2)]);
    const twice = reflow(board, [p("d", 2, 0, 4, 2)]);
    expect(once).toEqual(twice);
    expect(once.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(hasOverlap(once)).toBe(false);
  });

  it("never overlaps, whatever is dropped where (randomised)", () => {
    let seed = 7;
    const random = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let round = 0; round < 300; round += 1) {
      const items = board.map((item) => item.id);
      const id = items[random(items.length)] ?? "a";
      const w = 3 + random(10);
      const rect = p(id, random(13 - w), random(8), w, 1 + random(4));
      const next = placeWidget(board, rect, "lg");
      expect(hasOverlap(next)).toBe(false);
      expect(at(next, id)).toMatchObject({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    }
  });

  it("keeps saved gaps when settling a stored desktop layout, and compacts the phone list", () => {
    expect(settle(board, "lg")).toEqual(board);
    const phone = [p("a", 0, 0, 1, 2), p("b", 0, 5, 1, 2)];
    expect(at(settle(phone, "sm"), "b")).toMatchObject({ y: 2 });
  });
});

describe("keyboard moves keep gaps", () => {
  it("moves into a free row above one step at a time, and down one row when nothing is below", () => {
    const up = moveWidget(board, "d", "up", "lg");
    expect(at(up, "d")).toMatchObject({ y: 4 });
    expect(at(up, "c")).toEqual(at(board, "c"));
    const down = moveWidget(board, "d", "down", "lg");
    expect(at(down, "d")).toMatchObject({ y: 6 });
  });

  it("swaps with the widget directly above or below, moving nothing else", () => {
    const up = moveWidget(board, "c", "up", "lg");
    expect(at(up, "c")).toMatchObject({ y: 0 });
    expect(at(up, "a")).toMatchObject({ y: 2 });
    expect(at(up, "b")).toMatchObject({ y: 2 });
    expect(hasOverlap(up)).toBe(false);
    const down = moveWidget(board, "a", "down", "lg");
    expect(at(down, "c")).toMatchObject({ y: 0 });
    expect(at(down, "a")).toMatchObject({ y: 2 });
    // b was in c's way when c came up, so it moves below c; d (after the gap) stays put.
    expect(at(down, "b")).toMatchObject({ y: 2 });
    expect(at(down, "d")).toEqual(at(board, "d"));
    expect(hasOverlap(down)).toBe(false);
  });

  it("shrinking leaves the space free; growing pushes only what it now covers", () => {
    const smaller = setSize(board, "c", "tasks", 6, 3, "lg");
    expect(at(smaller, "c")).toMatchObject({ x: 0, w: 6, h: 3 });
    expect(at(smaller, "d")).toMatchObject({ y: 5 });
  });

  it("reorders the phone list without gaps", () => {
    const phone = [p("a", 0, 0, 1, 2), p("b", 0, 2, 1, 3), p("c", 0, 5, 1, 2)];
    const moved = moveInStack(phone, "c", "up");
    expect(stackOrder(moved)).toEqual(["a", "c", "b"]);
    expect(at(moved, "c")).toMatchObject({ y: 2 });
    expect(at(moved, "b")).toMatchObject({ y: 4 });
    expect(moveInStack(phone, "a", "up")).toEqual(phone);
    expect(stackOrder(moveWidget(phone, "a", "down", "sm"))).toEqual(["b", "a", "c"]);
  });
});

describe("size presets (decision 4)", () => {
  it("offers Small, Medium, Large and Wide inside every type's bounds, without duplicates", () => {
    for (const type of widgetTypes) {
      for (const breakpoint of ["lg", "md", "sm"] as const) {
        const presets = sizePresets(type, breakpoint);
        const bounds = widgetRegistry[type].sizes[breakpoint];
        expect(presets.length).toBeGreaterThan(0);
        const keys = presets.map((preset) => `${String(preset.w)}x${String(preset.h)}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const preset of presets) {
          expect(preset.w).toBeGreaterThanOrEqual(bounds.minW);
          expect(preset.w).toBeLessThanOrEqual(bounds.maxW);
          expect(preset.h).toBeGreaterThanOrEqual(bounds.minH);
          expect(preset.h).toBeLessThanOrEqual(bounds.maxH);
        }
        if (breakpoint === "sm") expect(presets.some((preset) => preset.id === "wide")).toBe(false);
      }
    }
    expect(sizePresets("tasks", "lg")).toEqual([
      { id: "small", w: 4, h: 3 },
      { id: "medium", w: 6, h: 4 },
      { id: "large", w: 9, h: 6 },
      { id: "wide", w: 12, h: 4 },
    ]);
  });
});

describe("Add widget here (decision 3)", () => {
  it("finds the gaps inside the arrangement, never below the last widget or on the phone", () => {
    const slots = emptySlots(board, "lg");
    expect(slots).toEqual([
      { x: 0, y: 4, w: 12, h: 1 },
      { x: 4, y: 5, w: 8, h: 2 },
    ]);
    expect(emptySlots(board, "sm")).toEqual([]);
    expect(emptySlots([], "lg")).toEqual([]);
  });

  it("places a new widget in the slot and moves only what it overlaps", () => {
    const next = placeInSlot(board, "n", "tasks", { x: 4, y: 5, w: 8, h: 2 }, "lg");
    expect(at(next, "n")).toMatchObject({ x: 4, y: 5, w: 6, h: 4 });
    for (const id of ["a", "b", "c", "d"]) expect(at(next, id)).toEqual(at(board, id));
    expect(hasOverlap(next)).toBe(false);
    // A slot narrower than the widget's minimum still gets its minimum, pushing what is in the way.
    const tight = placeInSlot(board, "n", "tasks", { x: 0, y: 4, w: 12, h: 1 }, "lg");
    expect(at(tight, "n")).toMatchObject({ x: 0, y: 4, w: 6, h: 4 });
    expect(at(tight, "d")).toMatchObject({ y: 8 });
    expect(hasOverlap(tight)).toBe(false);
  });
});
