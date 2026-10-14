import { isActive, primaryNav, secondaryNav, unbuiltSections } from "./nav-items";

describe("navigation items", () => {
  it("marks the dashboard active only on the dashboard itself", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/calendar")).toBe(false);
  });

  it("marks a section active on its own pages, not on look-alike paths", () => {
    expect(isActive("/tasks", "/tasks")).toBe(true);
    expect(isActive("/tasks", "/tasks/123")).toBe(true);
    expect(isActive("/tasks", "/tasks-archive")).toBe(false);
  });

  it("has unique ids and addresses", () => {
    const all = [...primaryNav, ...secondaryNav];
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    expect(new Set(all.map((item) => item.href)).size).toBe(all.length);
  });

  it("only treats navigation sections as unbuilt, and never the dashboard or settings", () => {
    const ids = new Set([...primaryNav, ...secondaryNav].map((item) => item.id));
    for (const id of unbuiltSections) expect(ids.has(id)).toBe(true);
    expect(unbuiltSections.has("dashboard")).toBe(false);
    expect(unbuiltSections.has("settings")).toBe(false);
  });

  it("keeps Trash out of the sidebar (spec: reached from settings)", () => {
    expect([...primaryNav, ...secondaryNav].map((item) => item.href)).not.toContain("/trash");
  });
});
