import { describe, expect, it } from "vitest";

import { canMove, canResize, compact, hasOverlap, moveWidget, resizeWidget } from "./geometry";
import {
  addWidget,
  checkLayout,
  emptyLayout,
  MAX_WIDGETS,
  readLayout,
  removeWidget,
  templateCopy,
  visiblePlacements,
  type DashboardLayout,
  type LayoutContext,
} from "./layout";
import { homeStarterLayout, personalStarterLayout } from "./starter";
import { catalogueFor, defaultConfig, surfaceFor, widgetTypes } from "./widgets";

const HOME = "6f9b1c2e-4a1d-4e7b-9c3a-1b2c3d4e5f60";
const OTHER_HOME = "7a0c2d3f-5b2e-4f8c-8d4b-2c3d4e5f6071";
const personal: LayoutContext = { dashboard: "personal", allowedSourceHomeIds: new Set([HOME]) };
const home: LayoutContext = { dashboard: "home", allowedSourceHomeIds: new Set() };

let counter = 0;
function id(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
}

function withWidget(
  layout: DashboardLayout,
  type: (typeof widgetTypes)[number],
  source?: string,
): DashboardLayout {
  return addWidget(layout, {
    id: id(),
    type,
    hidden: false,
    config: defaultConfig(type),
    ...(source ? { source: { homeId: source } } : {}),
  });
}

describe("widget registry", () => {
  it("keeps notifications personal and Home members Home-scoped", () => {
    expect(surfaceFor("notifications", "personal", false)).toBe("personal");
    expect(surfaceFor("notifications", "home", false)).toBeNull();
    expect(surfaceFor("home-members", "personal", false)).toBeNull();
    expect(surfaceFor("home-members", "personal", true)).toBe("home-source");
    expect(surfaceFor("home-members", "home", false)).toBe("home");
    // A Home dashboard never carries a source binding: no cross-Home widgets there.
    expect(surfaceFor("home-members", "home", true)).toBeNull();
  });

  it("offers each dashboard only what fits it", () => {
    expect(catalogueFor("personal")).toEqual([
      { type: "welcome", needsSource: false },
      { type: "quick-actions", needsSource: false },
      { type: "notifications", needsSource: false },
      { type: "home-members", needsSource: true },
      { type: "tasks", needsSource: false },
      { type: "tasks", needsSource: true },
      { type: "my-chores", needsSource: true },
      { type: "home-chores", needsSource: true },
      { type: "chore-approvals", needsSource: true },
      { type: "chore-schedule", needsSource: true },
      { type: "home-vacation", needsSource: true },
      { type: "weekly-points", needsSource: true },
      { type: "points-leaderboard", needsSource: true },
      { type: "my-points", needsSource: true },
    ]);
    expect(catalogueFor("home").map((entry) => entry.type)).toEqual([
      "welcome",
      "quick-actions",
      "home-members",
      "tasks",
      "my-chores",
      "home-chores",
      "chore-approvals",
      "chore-schedule",
      "home-vacation",
      "weekly-points",
      "points-leaderboard",
      "my-points",
    ]);
  });

  it("has valid defaults for every type", () => {
    for (const type of widgetTypes) expect(defaultConfig(type)).toBeTypeOf("object");
    expect(defaultConfig("notifications")).toEqual({ count: 5 });
    expect(defaultConfig("chore-schedule")).toEqual({ layout: "matrix", limit: 3 });
  });
});

describe("starter layouts", () => {
  it("are valid layouts for their dashboards", () => {
    expect(checkLayout(personalStarterLayout, personal).ok).toBe(true);
    expect(checkLayout(homeStarterLayout, home).ok).toBe(true);
  });

  it("put no Home widget on the personal starter", () => {
    expect(personalStarterLayout.widgets.some((w) => w.source || w.type === "home-members")).toBe(
      false,
    );
  });
});

describe("checkLayout", () => {
  it("accepts an intentionally empty dashboard", () => {
    expect(checkLayout(emptyLayout(), personal)).toEqual({ ok: true, layout: emptyLayout() });
  });

  it("refuses a wrong shape or version", () => {
    expect(checkLayout({ ...emptyLayout(), version: 2 }, personal)).toEqual({
      ok: false,
      issue: "shape",
    });
    expect(checkLayout([], personal)).toMatchObject({ issue: "shape" });
    expect(checkLayout({ ...emptyLayout(), extra: 1 }, personal)).toMatchObject({ issue: "shape" });
  });

  it("refuses unknown types and widgets on the wrong dashboard", () => {
    const layout = withWidget(emptyLayout(), "welcome");
    const first = layout.widgets[0];
    if (!first) throw new Error("no widget");
    expect(
      checkLayout({ ...layout, widgets: [{ ...first, type: "spotify" }] }, personal),
    ).toMatchObject({ issue: "unknown-type" });
    expect(checkLayout(withWidget(emptyLayout(), "notifications"), home)).toMatchObject({
      issue: "surface",
    });
    expect(checkLayout(withWidget(emptyLayout(), "home-members"), personal)).toMatchObject({
      issue: "surface",
    });
    expect(checkLayout(withWidget(emptyLayout(), "home-members", HOME), home)).toMatchObject({
      issue: "surface",
    });
  });

  it("binds Home widgets only to allowed Homes", () => {
    expect(checkLayout(withWidget(emptyLayout(), "home-members", HOME), personal).ok).toBe(true);
    expect(
      checkLayout(withWidget(emptyLayout(), "home-members", OTHER_HOME), personal),
    ).toMatchObject({ issue: "source" });
  });

  it("allows the same widget type twice, from two Homes", () => {
    const twoHomes: LayoutContext = {
      dashboard: "personal",
      allowedSourceHomeIds: new Set([HOME, OTHER_HOME]),
    };
    const layout = withWidget(
      withWidget(emptyLayout(), "home-members", HOME),
      "home-members",
      OTHER_HOME,
    );
    expect(checkLayout(layout, twoHomes).ok).toBe(true);
  });

  it("refuses settings that do not fit the type", () => {
    const layout = withWidget(emptyLayout(), "notifications");
    const first = layout.widgets[0];
    if (!first) throw new Error("no widget");
    expect(
      checkLayout({ ...layout, widgets: [{ ...first, config: { count: 7 } }] }, personal),
    ).toMatchObject({ issue: "config" });
    expect(
      checkLayout(
        { ...layout, widgets: [{ ...first, config: { count: 3, extra: true } }] },
        personal,
      ),
    ).toMatchObject({ issue: "config" });
  });

  it("requires every widget placed once in every breakpoint, inside the grid and its size bounds", () => {
    const layout = withWidget(emptyLayout(), "welcome");
    const placement = layout.placements.lg[0];
    if (!placement) throw new Error("no placement");
    expect(
      checkLayout({ ...layout, placements: { ...layout.placements, md: [] } }, personal),
    ).toMatchObject({ issue: "placement-missing" });
    expect(
      checkLayout(
        { ...layout, placements: { ...layout.placements, lg: [placement, placement] } },
        personal,
      ),
    ).toMatchObject({ issue: "duplicate-id" });
    expect(
      checkLayout(
        { ...layout, placements: { ...layout.placements, lg: [{ ...placement, id: id() }] } },
        personal,
      ),
    ).toMatchObject({ issue: "placement-unknown" });
    expect(
      checkLayout(
        { ...layout, placements: { ...layout.placements, lg: [{ ...placement, x: 8 }] } },
        personal,
      ),
    ).toMatchObject({ issue: "bounds" });
    expect(
      checkLayout(
        { ...layout, placements: { ...layout.placements, lg: [{ ...placement, w: 2 }] } },
        personal,
      ),
    ).toMatchObject({ issue: "size" });
    expect(
      checkLayout(
        { ...layout, placements: { ...layout.placements, sm: [{ ...placement, w: 2, x: 0 }] } },
        personal,
      ),
    ).toMatchObject({ issue: "bounds" });
  });

  it("refuses overlapping widgets", () => {
    const layout = withWidget(withWidget(emptyLayout(), "welcome"), "quick-actions");
    const [a, b] = layout.placements.lg;
    if (!a || !b) throw new Error("no placements");
    expect(
      checkLayout(
        { ...layout, placements: { ...layout.placements, lg: [a, { ...b, x: 2, y: 0 }] } },
        personal,
      ),
    ).toMatchObject({ issue: "overlap" });
  });

  it(`refuses more than ${String(MAX_WIDGETS)} widgets`, () => {
    let layout = emptyLayout();
    for (let i = 0; i <= MAX_WIDGETS; i += 1) layout = withWidget(layout, "welcome");
    expect(checkLayout(layout, personal)).toMatchObject({ issue: "shape" });
  });
});

describe("readLayout", () => {
  it("returns a valid layout unchanged", () => {
    expect(readLayout(personalStarterLayout, "personal")).toEqual({
      layout: personalStarterLayout,
      dropped: false,
    });
  });

  it("drops what it does not recognise and repairs placements", () => {
    const layout = withWidget(withWidget(emptyLayout(), "welcome"), "quick-actions");
    const [welcome, actions] = layout.widgets;
    if (!welcome || !actions) throw new Error("no widgets");
    const stored = {
      ...layout,
      widgets: [
        { ...welcome, config: { showDate: "yes" } },
        { ...actions, type: "removed-module" },
      ],
      placements: { ...layout.placements, md: [] },
    };
    const read = readLayout(stored, "personal");
    expect(read.dropped).toBe(true);
    expect(read.layout.widgets).toEqual([{ ...welcome, config: { showDate: true } }]);
    expect(read.layout.placements.md.map((p) => p.id)).toEqual([welcome.id]);
    expect(checkLayout(read.layout, personal).ok).toBe(true);
  });

  it("drops Home widgets from a Home dashboard that somehow holds a source", () => {
    const read = readLayout(withWidget(emptyLayout(), "home-members", HOME), "home");
    expect(read).toEqual({ layout: emptyLayout(), dropped: true });
  });

  it("shows an unreadable layout as empty, and says so", () => {
    expect(readLayout("not a layout", "personal")).toEqual({
      layout: emptyLayout(),
      dropped: true,
    });
  });
});

describe("editing", () => {
  it("adds at the bottom and removes without leaving a gap", () => {
    let layout = withWidget(emptyLayout(), "welcome");
    layout = withWidget(layout, "notifications");
    expect(layout.placements.lg[1]).toMatchObject({ x: 0, y: 2 });
    const firstId = layout.widgets[0]?.id ?? "";
    layout = removeWidget(layout, firstId);
    expect(layout.placements.lg).toEqual([expect.objectContaining({ x: 0, y: 0 })]);
    expect(checkLayout(layout, personal).ok).toBe(true);
  });

  it("leaves hidden widgets out of normal view and closes their space", () => {
    const layout = personalStarterLayout;
    const hidden = {
      ...layout,
      widgets: layout.widgets.map((w) => (w.type === "welcome" ? { ...w, hidden: true } : w)),
    };
    const visible = visiblePlacements(hidden, "sm");
    expect(visible).toHaveLength(3);
    expect(visible[0]).toMatchObject({ y: 0 });
  });

  it("copies a template with new ids and without Home bindings", () => {
    const layout = withWidget(withWidget(emptyLayout(), "welcome"), "home-members", HOME);
    const copy = templateCopy(layout, id);
    expect(copy.dropped).toBe(1);
    expect(copy.layout.widgets).toHaveLength(1);
    expect(copy.layout.widgets[0]?.id).not.toBe(layout.widgets[0]?.id);
    expect(checkLayout(copy.layout, personal).ok).toBe(true);
  });
});

describe("keyboard move and resize", () => {
  const [welcome, actions, notifications] = personalStarterLayout.widgets.map((w) => w.id);
  const lg = personalStarterLayout.placements.lg;

  it("moves left and right within the grid", () => {
    const moved = moveWidget(lg, actions ?? "", "left", "lg");
    // Quick actions (x 6) move a column left; welcome is pushed down out of the way.
    expect(moved.find((p) => p.id === actions)).toMatchObject({ x: 5 });
    expect(hasOverlap(moved)).toBe(false);
    expect(canMove(lg, welcome ?? "", "left", "lg")).toBe(false);
  });

  it("moves up and down past the neighbour", () => {
    const down = moveWidget(lg, welcome ?? "", "down", "lg");
    const welcomeAfter = down.find((p) => p.id === welcome);
    const notificationsAfter = down.find((p) => p.id === notifications);
    expect(notificationsAfter?.y).toBe(0);
    expect(welcomeAfter?.y).toBeGreaterThan(0);
    expect(hasOverlap(down)).toBe(false);
    const up = moveWidget(down, welcome ?? "", "up", "lg");
    expect(up.find((p) => p.id === welcome)?.y).toBe(0);
    expect(canMove(lg, welcome ?? "", "up", "lg")).toBe(false);
  });

  it("changes order on a one-column phone layout", () => {
    const sm = personalStarterLayout.placements.sm;
    const moved = moveWidget(sm, notifications ?? "", "up", "sm");
    const order = [...moved].sort((a, b) => a.y - b.y).map((p) => p.id);
    expect(order.slice(0, 3)).toEqual([welcome, notifications, actions]);
  });

  it("resizes within the type's bounds and pushes others down", () => {
    const wider = resizeWidget(lg, welcome ?? "", "welcome", "wider", "lg");
    expect(wider.find((p) => p.id === welcome)).toMatchObject({ w: 7 });
    expect(hasOverlap(wider)).toBe(false);
    expect(canResize(lg, welcome ?? "", "welcome", "shorter", "lg")).toBe(false);
    const sm = personalStarterLayout.placements.sm;
    expect(canResize(sm, welcome ?? "", "welcome", "wider", "sm")).toBe(false);
  });

  it("compacts to the same result as the grid would", () => {
    const gapped = lg.map((p) => (p.id === notifications ? { ...p, y: 9 } : p));
    expect(compact(gapped, "lg").find((p) => p.id === notifications)?.y).toBe(2);
  });
});
