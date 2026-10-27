import {
  contextHref,
  homeIdFromPath,
  isActive,
  isUnbuiltSection,
  primaryNav,
  secondaryNav,
  unbuiltSections,
} from "./nav-items";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

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

  it("opens recipes from Meals, in the open Home or the Personal space (S24)", () => {
    const meals = primaryNav.find((item) => item.id === "meals");
    if (!meals) throw new Error("Meals is missing");
    expect(contextHref(meals, null)).toBe("/recipes");
    expect(contextHref(meals, HOME)).toBe(`/homes/${HOME}/recipes`);
    expect(isUnbuiltSection("meals")).toBe(false);
  });

  it("keeps Trash out of the sidebar (spec: reached from settings)", () => {
    expect([...primaryNav, ...secondaryNav].map((item) => item.href)).not.toContain("/trash");
  });

  it("reads the open Home from the address, and nothing else", () => {
    expect(homeIdFromPath(`/homes/${HOME}`)).toBe(HOME);
    expect(homeIdFromPath(`/homes/${HOME}/settings`)).toBe(HOME);
    expect(homeIdFromPath(`/homes/${HOME.toUpperCase()}`)).toBe(HOME);
    expect(homeIdFromPath("/homes/new")).toBeNull();
    expect(homeIdFromPath("/homes/join")).toBeNull();
    expect(homeIdFromPath(`/homes/${HOME}x`)).toBeNull();
    expect(homeIdFromPath("/")).toBeNull();
    expect(homeIdFromPath("/settings")).toBeNull();
  });

  it("points Dashboard at the open Home, and leaves every other item alone", () => {
    const [dashboard, calendar] = primaryNav;
    if (!dashboard || !calendar) throw new Error("navigation items missing");
    expect(contextHref(dashboard, HOME)).toBe(`/homes/${HOME}`);
    expect(contextHref(dashboard, null)).toBe("/?context=personal");
    expect(isActive(contextHref(dashboard, null), "/")).toBe(true);
    expect(isActive(contextHref(dashboard, null), "/settings")).toBe(false);
    expect(contextHref(calendar, HOME)).toBe("/calendar");
  });

  it("marks a Home's dashboard active only on that page, not on its settings", () => {
    expect(isActive(`/homes/${HOME}`, `/homes/${HOME}`)).toBe(true);
    expect(isActive(`/homes/${HOME}`, `/homes/${HOME}/settings`)).toBe(false);
  });

  it("points Tasks at the open Home's tasks (S18), active on its pages too", () => {
    const tasks = primaryNav.find((item) => item.id === "tasks");
    if (!tasks) throw new Error("tasks item missing");
    expect(contextHref(tasks, HOME)).toBe(`/homes/${HOME}/tasks`);
    expect(contextHref(tasks, null)).toBe("/tasks");
    expect(isActive(`/homes/${HOME}/tasks`, `/homes/${HOME}/tasks/manage`)).toBe(true);
    expect(isActive(`/homes/${HOME}/tasks`, `/homes/${HOME}/tasks-x`)).toBe(false);
    expect(isActive(`/homes/${HOME}/tasks`, `/homes/${HOME}`)).toBe(false);
    expect(isActive(`/homes/${HOME}`, `/homes/${HOME}/tasks`)).toBe(false);
  });

  it("points Chores at the open Home's chores (S20) and marks it built", () => {
    const chores = primaryNav.find((item) => item.id === "chores");
    if (!chores) throw new Error("chores item missing");
    expect(contextHref(chores, HOME)).toBe(`/homes/${HOME}/chores`);
    expect(contextHref(chores, null)).toBe("/chores");
    expect(isUnbuiltSection("chores")).toBe(false);
    expect(isActive(`/homes/${HOME}/chores`, `/homes/${HOME}/chores/manage`)).toBe(true);
  });
});
