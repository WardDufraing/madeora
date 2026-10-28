import type { Mock } from "vitest";

import { GET as previewCopy, POST as copyWeek } from "./copy-week/route";
import { DELETE as deleteEntry, PATCH as patchEntry } from "./entries/[entryId]/route";
import { POST as createEntry } from "./entries/route";
import { POST as restoreOccurrence } from "./occurrences/[recurrenceId]/[date]/restore/route";
import {
  DELETE as skipOccurrence,
  PUT as editOccurrence,
} from "./occurrences/[recurrenceId]/[date]/route";
import { GET as plan } from "./plan/route";
import { GET as recipes } from "./recipes/route";
import { PATCH as patchSeries } from "./series/[seriesId]/route";
import { POST as series } from "./series/route";
import { PATCH as patchSettings } from "./settings/route";
import { GET as transferPreview, POST as transfer } from "./shopping-transfer/route";
import { GET as slotImpact } from "./slots/[slotId]/impact/route";
import { POST as moveSlot } from "./slots/[slotId]/move/route";
import { PATCH as patchSlot } from "./slots/[slotId]/route";
import { POST as createSlot } from "./slots/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const SLOT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const OTHER_ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const RECIPE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
const SERIES = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const RECURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";
const ITEM = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0051";
const TRANSFER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0060";
const today = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) as unknown;

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) =>
        Promise.resolve(state.rpc(name, args ?? {})),
    }),
}));
vi.mock("@/preferences/server", () => ({
  getEffectiveTimeZone: () => Promise.resolve({ timeZone: "Europe/Brussels", source: "chosen" }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function request(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = sameOrigin,
): Request {
  return new Request(`https://madeora.example/api/v1/meals${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = <T extends Record<string, string>>(values: T) => ({
  params: Promise.resolve(values),
});

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

const content = { recipe: null, title: "Soep", notes: null, servings: null, type: "custom" };
const entry = {
  kind: "entry",
  id: OTHER_ENTRY,
  revision: 1,
  origin: null,
  date: "2026-11-02",
  slotId: SLOT,
  ...content,
};
const thePlan = {
  access: "manage",
  memberAccess: "edit",
  settingsRevision: 0,
  today: "2026-10-28",
  from: "2026-10-26",
  to: "2026-11-01",
  slots: [{ id: SLOT, standardKey: "dinner", name: null, position: 3, enabled: true, revision: 1 }],
  entries: [{ ...entry, date: "2026-10-28" }],
  occurrences: [],
  series: [],
  token: "abc",
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("meal plan reads", () => {
  it("reads a Home's plan with the person's session, uncached, without passing a day", async () => {
    answers({ get_meal_plan: thePlan });
    const response = await plan(
      request(`/plan?homeId=${HOME}&from=2026-10-26&to=2026-11-01`, "GET"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ plan: thePlan });
    expect(state.rpc).toHaveBeenCalledWith("get_meal_plan", {
      p_home_id: HOME,
      p_from: "2026-10-26",
      p_to: "2026-11-01",
    });
  });

  it("passes the person's own day for the Personal space", async () => {
    answers({ get_meal_plan: thePlan });
    expect((await plan(request("/plan", "GET"))).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("get_meal_plan", { p_today: today });
  });

  it("answers a Home the person is not in like one that does not exist", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await plan(request(`/plan?homeId=${HOME}`, "GET"))).status).toBe(404);
  });

  it("refuses a malformed date or unknown parameter before asking the database", async () => {
    expect((await plan(request("/plan?from=2026-02-30", "GET"))).status).toBe(400);
    expect((await plan(request("/plan?other=1", "GET"))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("never passes on a plan of an unexpected shape", async () => {
    answers({ get_meal_plan: { ...thePlan, entries: [{ id: "x" }] } });
    expect((await plan(request("/plan", "GET"))).status).toBe(500);
  });

  it("lists the recipes that may be planned, trimmed search", async () => {
    answers({ list_meal_recipes: [{ id: RECIPE, name: "Lasagne", servings: 4 }] });
    const response = await recipes(request(`/recipes?homeId=${HOME}&q=%20las%20`, "GET"));
    expect(await response.json()).toEqual({
      recipes: [{ id: RECIPE, name: "Lasagne", servings: 4 }],
    });
    expect(state.rpc).toHaveBeenCalledWith("list_meal_recipes", {
      p_home_id: HOME,
      p_query: "las",
    });
  });

  it("refuses reads and changes without a verified identity", async () => {
    state.identity = null;
    expect((await plan(request("/plan", "GET"))).status).toBe(401);
    expect(
      (
        await createEntry(
          request("/entries", "POST", {
            id: ENTRY,
            homeId: null,
            date: "2026-11-02",
            slotId: SLOT,
            title: "Soep",
          }),
        )
      ).status,
    ).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("planned meals", () => {
  const newMeal = { id: ENTRY, homeId: HOME, date: "2026-11-02", slotId: SLOT };

  it("refuses a cross-site change before reading it", async () => {
    const response = await createEntry(
      request(
        "/entries",
        "POST",
        { ...newMeal, title: "Soep" },
        {
          origin: "https://evil.example",
          host: "madeora.example",
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("plans a recipe with servings under the client's id", async () => {
    answers({ create_meal_entry: [{ outcome: "created", revision: 1, occupied: null }] });
    const response = await createEntry(
      request("/entries", "POST", { ...newMeal, recipeId: RECIPE, servings: 6 }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: ENTRY, revision: 1 });
    expect(state.rpc).toHaveBeenCalledWith("create_meal_entry", {
      p_id: ENTRY,
      p_on: "2026-11-02",
      p_slot_id: SLOT,
      p_home_id: HOME,
      p_recipe_id: RECIPE,
      p_servings: 6,
    });
  });

  it("needs exactly one of a recipe or a title, and servings only with a recipe", async () => {
    const both = await createEntry(
      request("/entries", "POST", { ...newMeal, recipeId: RECIPE, title: "Soep" }),
    );
    const neither = await createEntry(request("/entries", "POST", newMeal));
    const servings = await createEntry(
      request("/entries", "POST", { ...newMeal, title: "Soep", servings: 2 }),
    );
    const blank = await createEntry(request("/entries", "POST", { ...newMeal, title: "   " }));
    for (const response of [both, neither, servings, blank]) expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a taken slot with what is there, and replaces it only with its key", async () => {
    const occupied = { occupants: [entry], replaceKey: "key-1" };
    answers({ create_meal_entry: [{ outcome: "occupied", revision: null, occupied }] });
    const first = await createEntry(request("/entries", "POST", { ...newMeal, title: "Soep" }));
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ error: "occupied", occupied });

    answers({ create_meal_entry: [{ outcome: "created", revision: 1, occupied: null }] });
    const replaced = await createEntry(
      request("/entries", "POST", { ...newMeal, title: "Soep", replace: "key-1" }),
    );
    expect(replaced.status).toBe(201);
    expect(state.rpc).toHaveBeenLastCalledWith(
      "create_meal_entry",
      expect.objectContaining({ p_replace: "key-1" }),
    );
  });

  it("maps a recipe that is no longer visible and a closed slot", async () => {
    answers({
      create_meal_entry: [{ outcome: "recipe_unavailable", revision: null, occupied: null }],
    });
    const recipe = await createEntry(request("/entries", "POST", { ...newMeal, recipeId: RECIPE }));
    expect(await recipe.json()).toEqual({ error: "recipe-unavailable" });
    answers({
      create_meal_entry: [{ outcome: "slot_unavailable", revision: null, occupied: null }],
    });
    const slot = await createEntry(request("/entries", "POST", { ...newMeal, title: "Soep" }));
    expect(await slot.json()).toEqual({ error: "slot-unavailable" });
  });

  it("refuses a viewer's change with 403", async () => {
    answers({ create_meal_entry: [{ outcome: "not_permitted", revision: null, occupied: null }] });
    const response = await createEntry(request("/entries", "POST", { ...newMeal, title: "Soep" }));
    expect(response.status).toBe(403);
  });

  it("edits a meal from its revision, keeping its recipe when neither is sent", async () => {
    answers({ update_meal_entry: [{ outcome: "saved", revision: 3, occupied: null }] });
    const response = await patchEntry(
      request(`/entries/${ENTRY}`, "PATCH", {
        revision: 2,
        date: "2026-11-03",
        slotId: SLOT,
        servings: 4,
      }),
      params({ entryId: ENTRY }),
    );
    expect(await response.json()).toEqual({ id: ENTRY, revision: 3 });
    expect(state.rpc).toHaveBeenCalledWith("update_meal_entry", {
      p_id: ENTRY,
      p_expected_revision: 2,
      p_on: "2026-11-03",
      p_slot_id: SLOT,
      p_servings: 4,
    });
  });

  it("answers a stale edit with the current revision", async () => {
    answers({ update_meal_entry: [{ outcome: "conflict", revision: 5, occupied: null }] });
    const response = await patchEntry(
      request(`/entries/${ENTRY}`, "PATCH", { revision: 2, date: "2026-11-03", slotId: SLOT }),
      params({ entryId: ENTRY }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", revision: 5 });
  });

  it("answers a malformed id like a missing meal", async () => {
    const response = await patchEntry(
      request("/entries/x", "PATCH", { revision: 2, date: "2026-11-03", slotId: SLOT }),
      params({ entryId: "x" }),
    );
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("moves a meal to the trash from its revision", async () => {
    answers({ delete_meal_entry: [{ outcome: "deleted", entry_id: TRANSFER }] });
    const response = await deleteEntry(
      request(`/entries/${ENTRY}`, "DELETE", { revision: 2 }),
      params({ entryId: ENTRY }),
    );
    expect(await response.json()).toEqual({ id: ENTRY, entryId: TRANSFER });
    expect(state.rpc).toHaveBeenCalledWith("delete_meal_entry", {
      p_id: ENTRY,
      p_expected_revision: 2,
    });
  });
});

describe("repeating meals", () => {
  const occurrence = params({ recurrenceId: RECURRENCE, date: "2026-11-04" });

  it("edits one occurrence into a meal of its own", async () => {
    answers({ edit_meal_occurrence: [{ outcome: "saved", revision: 1, occupied: null }] });
    const response = await editOccurrence(
      request(`/occurrences/${RECURRENCE}/2026-11-04`, "PUT", {
        entryId: ENTRY,
        date: "2026-11-05",
        slotId: SLOT,
        title: "Pizza",
      }),
      occurrence,
    );
    expect(await response.json()).toEqual({ id: ENTRY, revision: 1 });
    expect(state.rpc).toHaveBeenCalledWith("edit_meal_occurrence", {
      p_recurrence_id: RECURRENCE,
      p_on: "2026-11-04",
      p_entry_id: ENTRY,
      p_new_on: "2026-11-05",
      p_slot_id: SLOT,
      p_title: "Pizza",
    });
  });

  it("skips and restores one occurrence; an invalid date is not found", async () => {
    answers({ skip_meal_occurrence: "skipped" });
    expect((await skipOccurrence(request("/o", "DELETE", {}), occurrence)).status).toBe(200);
    answers({
      restore_meal_occurrence: [
        { outcome: "occupied", occupied: { occupants: [], replaceKey: "k" } },
      ],
    });
    const restored = await restoreOccurrence(request("/o", "POST", {}), occurrence);
    expect(restored.status).toBe(409);
    const bad = await skipOccurrence(
      request("/o", "DELETE", {}),
      params({ recurrenceId: RECURRENCE, date: "2026-13-01" }),
    );
    expect(bad.status).toBe(404);
  });

  const schedule = { slotId: SLOT, cadence: "weekdays", weekdays: [1, 3], startOn: "2026-11-02" };

  it("previews a new series with the person's day and an empty weekday list for daily", async () => {
    const preview = { nextDates: ["2026-11-02"], collisions: [], token: "t" };
    answers({ preview_meal_series: [{ outcome: "ok", preview }] });
    const response = await series(
      request("/series", "POST", {
        action: "preview",
        homeId: null,
        ...schedule,
        cadence: "daily",
        weekdays: null,
      }),
    );
    expect(await response.json()).toEqual({ preview });
    expect(state.rpc).toHaveBeenCalledWith("preview_meal_series", {
      p_slot_id: SLOT,
      p_cadence: "daily",
      p_weekdays: [],
      p_start_on: "2026-11-02",
      p_today: today,
    });
  });

  it("refuses a weekday schedule without weekdays", async () => {
    const response = await series(
      request("/series", "POST", { action: "preview", homeId: HOME, ...schedule, weekdays: [] }),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("creates a series with its decisions, or answers the current collisions", async () => {
    const collisions = [{ date: "2026-11-04", occupants: [entry], replaceKey: "k" }];
    answers({ create_meal_series: [{ outcome: "conflicts", revision: null, collisions }] });
    const body = {
      action: "create",
      id: SERIES,
      homeId: HOME,
      ...schedule,
      title: "Pasta",
      token: "t",
      decisions: { "2026-11-04": "skip" },
    };
    const stale = await series(request("/series", "POST", body));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflicts", collisions });
    expect(state.rpc).toHaveBeenCalledWith("create_meal_series", {
      p_id: SERIES,
      p_slot_id: SLOT,
      p_cadence: "weekdays",
      p_weekdays: [1, 3],
      p_start_on: "2026-11-02",
      p_token: "t",
      p_decisions: { "2026-11-04": "skip" },
      p_home_id: HOME,
      p_title: "Pasta",
    });
    answers({ create_meal_series: [{ outcome: "created", revision: 1, collisions: null }] });
    expect((await series(request("/series", "POST", body))).status).toBe(201);
  });

  it("pauses, ends and edits a series from its revision", async () => {
    answers({ update_meal_series: [{ outcome: "saved", revision: 4, collisions: null }] });
    const route = params({ seriesId: SERIES });
    await patchSeries(request("/s", "PATCH", { action: "pause", revision: 3 }), route);
    expect(state.rpc).toHaveBeenLastCalledWith("update_meal_series", {
      p_id: SERIES,
      p_expected_revision: 3,
      p_action: "pause",
      p_today: today,
    });
    await patchSeries(
      request("/s", "PATCH", { action: "end", revision: 3, from: "2026-11-10" }),
      route,
    );
    expect(state.rpc).toHaveBeenLastCalledWith(
      "update_meal_series",
      expect.objectContaining({ p_action: "end", p_from: "2026-11-10" }),
    );
    const edited = await patchSeries(
      request("/s", "PATCH", {
        action: "editFuture",
        revision: 3,
        from: "2026-11-10",
        slotId: SLOT,
        cadence: "weekly",
        weekdays: [5],
        title: "Vis",
        token: "t",
      }),
      route,
    );
    expect(await edited.json()).toEqual({ id: SERIES, revision: 4 });
    expect(state.rpc).toHaveBeenLastCalledWith("update_meal_series", {
      p_id: SERIES,
      p_expected_revision: 3,
      p_action: "edit_future",
      p_from: "2026-11-10",
      p_token: "t",
      p_decisions: {},
      p_slot_id: SLOT,
      p_cadence: "weekly",
      p_weekdays: [5],
      p_title: "Vis",
      p_today: today,
    });
  });

  it("previews a change of an existing series, excluding its own occurrences", async () => {
    answers({ preview_meal_series: [{ outcome: "invalid_date", preview: null }] });
    const response = await patchSeries(
      request("/s", "PATCH", {
        action: "preview",
        homeId: HOME,
        from: "2026-10-01",
        slotId: SLOT,
        cadence: "daily",
        weekdays: null,
      }),
      params({ seriesId: SERIES }),
    );
    expect(await response.json()).toEqual({ error: "invalid-date" });
    expect(state.rpc).toHaveBeenCalledWith(
      "preview_meal_series",
      expect.objectContaining({ p_series_id: SERIES, p_start_on: "2026-10-01" }),
    );
  });
});

describe("slots and settings", () => {
  it("adds a custom slot, and maps the limit and a taken name", async () => {
    answers({ create_meal_slot: [{ outcome: "limit_reached", revision: null }] });
    const full = await createSlot(
      request("/slots", "POST", { id: SLOT, homeId: HOME, name: "Snack" }),
    );
    expect(await full.json()).toEqual({ error: "limit-reached" });
    answers({ create_meal_slot: [{ outcome: "name_taken", revision: null }] });
    const taken = await createSlot(
      request("/slots", "POST", { id: SLOT, homeId: HOME, name: "Snack" }),
    );
    expect(await taken.json()).toEqual({ error: "name-taken" });
  });

  it("asks for the impact before disabling a slot that holds meals", async () => {
    const impact = { futureMeals: 2, pastMeals: 1, series: 1, token: "i" };
    answers({ update_meal_slot: [{ outcome: "impact_required", revision: null, impact }] });
    const response = await patchSlot(
      request(`/slots/${SLOT}`, "PATCH", { revision: 1, name: null, enabled: false }),
      params({ slotId: SLOT }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "impact-required", impact });
    expect(state.rpc).toHaveBeenCalledWith("update_meal_slot", {
      p_slot_id: SLOT,
      p_expected_revision: 1,
      p_enabled: false,
      p_today: today,
    });
  });

  it("reads a slot's impact and moves it", async () => {
    const impact = { futureMeals: 0, pastMeals: 0, series: 0, token: "i" };
    answers({ meal_slot_impact: [{ outcome: "ok", impact }], move_meal_slot: "unchanged" });
    const read = await slotImpact(
      request(`/slots/${SLOT}/impact`, "GET"),
      params({ slotId: SLOT }),
    );
    expect(await read.json()).toEqual({ impact });
    const moved = await moveSlot(
      request(`/slots/${SLOT}/move`, "POST", { direction: "up" }),
      params({ slotId: SLOT }),
    );
    expect(moved.status).toBe(200);
  });

  it("sets the members' access from the settings revision", async () => {
    answers({ update_meal_settings: [{ outcome: "conflict", revision: 2 }] });
    const response = await patchSettings(
      request("/settings", "PATCH", { homeId: HOME, revision: 1, memberAccess: "view" }),
    );
    expect(await response.json()).toEqual({ error: "conflict", revision: 2 });
  });
});

describe("copy week and shopping transfer", () => {
  it("previews and copies a week; a changed preview copies nothing", async () => {
    answers({ preview_meal_copy: [{ outcome: "ok", preview: { rows: [], token: "c" } }] });
    const preview = await previewCopy(
      request(`/copy-week?homeId=${HOME}&source=2026-10-26&destination=2026-11-02`, "GET"),
    );
    expect(await preview.json()).toEqual({ preview: { rows: [], token: "c" } });

    const body = {
      homeId: HOME,
      source: "2026-10-26",
      destination: "2026-11-02",
      token: "c",
      rows: [{ key: `e:${OTHER_ENTRY}`, id: ENTRY }],
    };
    answers({ copy_meal_week: [{ outcome: "stale", results: null }] });
    expect((await copyWeek(request("/copy-week", "POST", body))).status).toBe(409);
    answers({
      copy_meal_week: [
        { outcome: "done", results: [{ key: `e:${OTHER_ENTRY}`, id: ENTRY, outcome: "created" }] },
      ],
    });
    const copied = await copyWeek(request("/copy-week", "POST", body));
    expect(await copied.json()).toEqual({
      results: [{ key: `e:${OTHER_ENTRY}`, id: ENTRY, outcome: "created" }],
    });
    expect(state.rpc).toHaveBeenLastCalledWith("copy_meal_week", {
      p_source: "2026-10-26",
      p_destination: "2026-11-02",
      p_token: "c",
      p_rows: [{ key: `e:${OTHER_ENTRY}`, id: ENTRY, replace: false }],
      p_home_id: HOME,
    });
  });

  it("refuses the same copy id twice in one request", async () => {
    const response = await copyWeek(
      request("/copy-week", "POST", {
        homeId: null,
        source: "2026-10-26",
        destination: "2026-11-02",
        token: "c",
        rows: [
          { key: "a", id: ENTRY },
          { key: "b", id: ENTRY },
        ],
      }),
    );
    expect(response.status).toBe(400);
  });

  it("previews a transfer with only the lists the person may add to", async () => {
    answers({
      preview_meal_ingredients: [{ outcome: "ok", preview: { meals: [], token: "x" } }],
      advance_shopping: 0,
      list_shopping_lists: [
        {
          id: LIST,
          name: "Groceries",
          position: 1,
          archived: false,
          member_access: "edit",
          access: "edit",
          revision: 1,
          active_items: 0,
          completed_items: 0,
        },
        {
          id: ITEM,
          name: "Read only",
          position: 2,
          archived: false,
          member_access: "check",
          access: "check",
          revision: 1,
          active_items: 0,
          completed_items: 0,
        },
      ],
    });
    const response = await transferPreview(
      request(`/shopping-transfer?homeId=${HOME}&from=2026-11-02&to=2026-11-08`, "GET"),
    );
    expect(await response.json()).toEqual({
      preview: { meals: [], token: "x", lists: [{ id: LIST, name: "Groceries", position: 1 }] },
    });
  });

  it("adds the reviewed rows, or nothing when the plan changed", async () => {
    const body = {
      id: TRANSFER,
      homeId: HOME,
      from: "2026-11-02",
      to: "2026-11-08",
      listId: LIST,
      token: "x",
      items: [{ id: ITEM, name: "Tomaten", quantity: "500", unit: "g" }],
    };
    answers({ transfer_meal_ingredients: [{ outcome: "stale", results: null }] });
    expect(await (await transfer(request("/shopping-transfer", "POST", body))).json()).toEqual({
      error: "stale",
    });
    answers({ transfer_meal_ingredients: [{ outcome: "list_unavailable", results: null }] });
    expect((await transfer(request("/shopping-transfer", "POST", body))).status).toBe(409);
    answers({
      transfer_meal_ingredients: [{ outcome: "done", results: [{ id: ITEM, outcome: "created" }] }],
    });
    const done = await transfer(request("/shopping-transfer", "POST", body));
    expect(await done.json()).toEqual({ results: [{ id: ITEM, outcome: "created" }] });
    expect(state.rpc).toHaveBeenLastCalledWith(
      "transfer_meal_ingredients",
      expect.objectContaining({
        p_id: TRANSFER,
        p_list_id: LIST,
        p_items: [
          {
            id: ITEM,
            name: "Tomaten",
            quantity: "500",
            unit: "g",
            packaging: null,
            notes: null,
            categoryId: null,
            allowDuplicate: false,
          },
        ],
      }),
    );
  });
});
