import { removeWidget } from "./layout";
import { homeStarterLayout } from "./starter";
import { withSuggestions } from "./suggestions";

const members = homeStarterLayout.widgets.find((widget) => widget.type === "home-members");
if (!members) throw new Error("the Home starter has a members widget");
const view = removeWidget(homeStarterLayout, members.id);

describe("withSuggestions", () => {
  it("adds a shared widget under its shared id, at the bottom, without moving anything", () => {
    const result = withSuggestions(view, [members]);
    expect(result.added).toEqual([members.id]);
    expect(result.skipped).toBe(0);
    expect(result.layout.widgets.map((widget) => widget.id)).toContain(members.id);
    for (const breakpoint of ["lg", "md", "sm"] as const) {
      for (const before of view.placements[breakpoint]) {
        expect(result.layout.placements[breakpoint]).toContainEqual(before);
      }
      const placed = result.layout.placements[breakpoint].find((p) => p.id === members.id);
      const lowest = Math.max(...view.placements[breakpoint].map((p) => p.y + p.h));
      expect(placed?.y).toBeGreaterThanOrEqual(lowest);
    }
  });

  it("skips a widget the view already holds", () => {
    const result = withSuggestions(homeStarterLayout, [members]);
    expect(result.added).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.layout).toBe(homeStarterLayout);
  });

  it("adds nothing for an empty choice", () => {
    expect(withSuggestions(view, [])).toEqual({ layout: view, added: [], skipped: 0 });
  });
});
