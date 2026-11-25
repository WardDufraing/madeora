import {
  contextHref,
  coreNavIds,
  createHref,
  homeIdFromPath,
  isActive,
  isItemActive,
  isUnbuiltSection,
  modulesHref,
  moduleNav,
  primaryNav,
  resolveFavorites,
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

  it("opens the meal planner from Meals, in the open Home or the Personal space (S27)", () => {
    const meals = primaryNav.find((item) => item.id === "meals");
    if (!meals) throw new Error("Meals is missing");
    expect(contextHref(meals, null)).toBe("/meals");
    expect(contextHref(meals, HOME)).toBe(`/homes/${HOME}/meals`);
    expect(isUnbuiltSection("meals")).toBe(false);
    // Recipes belong to the Meals section.
    expect(isItemActive(meals, null, "/recipes/abc")).toBe(true);
    expect(isItemActive(meals, HOME, `/homes/${HOME}/recipes`)).toBe(true);
    expect(isItemActive(meals, HOME, `/homes/${HOME}/meals/print`)).toBe(true);
    expect(isItemActive(meals, null, "/shopping")).toBe(false);
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
    const photos = primaryNav.find((item) => item.id === "photos");
    const integrations = primaryNav.find((item) => item.id === "integrations");
    if (!dashboard || !calendar || !photos || !integrations)
      throw new Error("navigation items missing");
    expect(contextHref(dashboard, HOME)).toBe(`/homes/${HOME}`);
    expect(contextHref(dashboard, null)).toBe("/?context=personal");
    expect(isActive(contextHref(dashboard, null), "/")).toBe(true);
    expect(isActive(contextHref(dashboard, null), "/settings")).toBe(false);
    expect(contextHref(calendar, HOME)).toBe(`/homes/${HOME}/calendar`);
    expect(contextHref(calendar, null)).toBe("/calendar");
    expect(contextHref(photos, HOME)).toBe(`/homes/${HOME}/photos`);
    expect(contextHref(photos, null)).toBe("/photos");
    expect(contextHref(integrations, HOME)).toBe("/integrations");
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

  it("points Shopping at the open Home's lists (S26) and marks it built", () => {
    const shopping = primaryNav.find((item) => item.id === "shopping");
    if (!shopping) throw new Error("shopping item missing");
    expect(contextHref(shopping, HOME)).toBe(`/homes/${HOME}/shopping`);
    expect(contextHref(shopping, null)).toBe("/shopping");
    expect(isUnbuiltSection("shopping")).toBe(false);
    expect(isActive(`/homes/${HOME}/shopping`, `/homes/${HOME}/shopping/${HOME}`)).toBe(true);
  });

  it("points Habits at the open Home's habits (S28) and marks it built", () => {
    const habits = primaryNav.find((item) => item.id === "habits");
    if (!habits) throw new Error("habits item missing");
    expect(contextHref(habits, HOME)).toBe(`/homes/${HOME}/habits`);
    expect(contextHref(habits, null)).toBe("/habits");
    expect(isUnbuiltSection("habits")).toBe(false);
    expect(isActive(`/homes/${HOME}/habits`, `/homes/${HOME}/habits/${HOME}`)).toBe(true);
  });

  it("points Goals at the open Home's goals (S30) and marks it built", () => {
    const goals = primaryNav.find((item) => item.id === "goals");
    if (!goals) throw new Error("goals item missing");
    expect(contextHref(goals, HOME)).toBe(`/homes/${HOME}/goals`);
    expect(contextHref(goals, null)).toBe("/goals");
    expect(isUnbuiltSection("goals")).toBe(false);
    expect(isActive(`/homes/${HOME}/goals`, `/homes/${HOME}/goals/${HOME}`)).toBe(true);
  });

  it("points Pets at the open Home's pets (S31) and marks it built", () => {
    const pets = primaryNav.find((item) => item.id === "pets");
    if (!pets) throw new Error("pets item missing");
    expect(contextHref(pets, HOME)).toBe(`/homes/${HOME}/pets`);
    expect(contextHref(pets, null)).toBe("/pets");
    expect(isUnbuiltSection("pets")).toBe(false);
    expect(isActive(`/homes/${HOME}/pets`, `/homes/${HOME}/pets/${HOME}/medical/${HOME}`)).toBe(
      true,
    );
  });
});

describe("module shortcuts", () => {
  it("uses the context defaults until the person chooses", () => {
    expect(resolveFavorites(null, null)).toEqual(["shopping", "habits", "goals"]);
    expect(resolveFavorites(null, "h")).toEqual(["chores", "meals", "shopping"]);
  });

  it("keeps the person's own order and drops anything that cannot be pinned", () => {
    expect(
      resolveFavorites(["pets", "tasks", "bogus", "settings", "pets", "chores"], null),
    ).toEqual(["pets", "chores"]);
    expect(resolveFavorites([], "h")).toEqual([]);
  });

  it("never lets core, secondary or unknown ids be pinned", () => {
    expect(moduleNav.map((item) => item.id)).not.toContain("dashboard");
    expect(moduleNav.map((item) => item.id)).not.toContain("settings");
    expect(coreNavIds).toEqual(["dashboard", "calendar", "tasks"]);
  });

  it("leads All modules and the quick-create entries to the open context", () => {
    expect(modulesHref(null)).toBe("/modules");
    expect(modulesHref("h")).toBe("/homes/h/modules");
    expect(createHref("event", null)).toBe("/calendar/new");
    expect(createHref("task", "h")).toBe("/homes/h/tasks");
    expect(createHref("shopping", null)).toBe("/shopping");
  });
});
