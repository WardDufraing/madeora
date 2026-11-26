import { checkLayout, type LayoutContext } from "./layout";
import { homeStarterLayout, personalStarterLayout } from "./starter";

const personal: LayoutContext = { dashboard: "personal", allowedSourceHomeIds: new Set() };
const home: LayoutContext = { dashboard: "home", allowedSourceHomeIds: new Set() };

describe("the personal starter layout", () => {
  it("has no Welcome widget, because the page heading already greets the person", () => {
    expect(personalStarterLayout.widgets.map((w) => w.type)).toEqual([
      "quick-actions",
      "notifications",
      "tasks",
      "upcoming-events",
    ]);
  });

  it("places every widget once in every breakpoint", () => {
    const ids = personalStarterLayout.widgets.map((w) => w.id).sort();
    for (const placements of Object.values(personalStarterLayout.placements)) {
      expect(placements.map((p) => p.id).sort()).toEqual(ids);
    }
  });

  it("passes the real layout validator, as does the Home starter", () => {
    expect(checkLayout(personalStarterLayout, personal).ok).toBe(true);
    expect(checkLayout(homeStarterLayout, home).ok).toBe(true);
  });

  it("has no overlapping widgets in any breakpoint", () => {
    for (const placements of Object.values(personalStarterLayout.placements)) {
      for (const [i, a] of placements.entries()) {
        for (const b of placements.slice(i + 1)) {
          const apart =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
      }
    }
  });
});
