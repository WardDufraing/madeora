import { personalStarterLayout } from "./starter";

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
});
