// S29: the numeric habit routes. The database decides targets, units, totals and rights
// (tests/db/rls/numeric-habits.test.sql); these tests check what the routes send it and how they
// answer, including the refusals that carry what explains them.
import type { Mock } from "vitest";

import { HABIT, numericHabitSummary } from "@/habits/testing";

import { PATCH as updateContribution } from "../habit-contributions/[contributionId]/route";
import { POST as addContribution, GET as readContributions } from "./[habitId]/contributions/route";
import { GET as readDays } from "./[habitId]/days/route";
import { PUT as setDayNote } from "./[habitId]/day-notes/[date]/route";
import { PUT as setQuickAdds } from "./[habitId]/quick-adds/route";
import { POST as changeTracking } from "./[habitId]/tracking/route";
import { POST as create } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const CONTRIBUTION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00c1";
const NEW_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00c2";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@/preferences/server", () => ({
  getEffectiveTimeZone: () => Promise.resolve({ timeZone: "Europe/Brussels", source: "account" }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const crossSite = { origin: "https://evil.example", host: "madeora.example" };

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const habitParams = { params: Promise.resolve({ habitId: HABIT }) };

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

const tracking = { target: "2000", unit: "ml", unitKind: "preset", quickAdds: ["250", "500"] };
const newHabit = {
  id: HABIT,
  homeId: null,
  name: "Drink water",
  schedule: { kind: "daily" },
  startsOn: "2026-11-10",
  weekStart: "monday",
};

describe("creating a numeric habit", () => {
  it("sends the target, unit and presets as exact numbers", async () => {
    answers({ create_habit: [{ outcome: "created", revision: 1 }] });
    const response = await create(request("/habits", "POST", { ...newHabit, tracking }));
    expect(response.status).toBe(201);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_tracking_target: 2000,
      p_tracking_unit: "ml",
      p_tracking_unit_kind: "preset",
      p_tracking_quick_adds: [250, 500],
    });
  });

  it("sends no tracking for a habit completed once", async () => {
    answers({ create_habit: [{ outcome: "created", revision: 1 }] });
    await create(request("/habits", "POST", newHabit));
    expect(state.rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_tracking_target");
  });

  it("refuses a weekly schedule, a localized decimal and a fraction of a whole unit", async () => {
    for (const body of [
      { ...newHabit, schedule: { kind: "weekly", target: 3 }, tracking },
      { ...newHabit, tracking: { ...tracking, target: "1,5" } },
      { ...newHabit, tracking: { ...tracking, unit: "glasses", target: "7.5", quickAdds: [] } },
    ]) {
      expect((await create(request("/habits", "POST", body))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("adding progress", () => {
  const path = `/habits/${HABIT}/contributions`;
  const body = { id: NEW_ID, quantity: "250" };

  it("adds exactly what was sent for the habit's today and answers the progress", async () => {
    const habit = numericHabitSummary();
    answers({
      add_habit_contribution: {
        outcome: "added",
        contributionId: CONTRIBUTION,
        completedNow: false,
        progress: habit.progress,
        streakBefore: 3,
        milestone: null,
        habit,
      },
    });
    const response = await addContribution(request(path, "POST", body), habitParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ outcome: "added", contributionId: CONTRIBUTION });
    expect(state.rpc).toHaveBeenCalledWith("add_habit_contribution", {
      p_id: NEW_ID,
      p_habit_id: HABIT,
      p_quantity: 250,
      p_source: "app",
    });
  });

  it("sends the date, the unit it was typed in and a widget's revision", async () => {
    answers({ add_habit_contribution: { outcome: "added", contributionId: CONTRIBUTION } });
    await addContribution(
      request(path, "POST", {
        ...body,
        quantity: "1.5",
        onDate: "2026-11-08",
        enteredUnit: "l",
        source: "widget",
        revision: 4,
      }),
      habitParams,
    );
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_quantity: 1.5,
      p_on: "2026-11-08",
      p_entered_unit: "l",
      p_source: "widget",
      p_expected_revision: 4,
    });
  });

  it("answers a retry with the first contribution, not a second one", async () => {
    answers({ add_habit_contribution: { outcome: "exists", contributionId: CONTRIBUTION } });
    const response = await addContribution(request(path, "POST", body), habitParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "exists" });
  });

  it("refuses a conversion that needs more decimals and says what it would be", async () => {
    answers({ add_habit_contribution: { outcome: "precision", converted: 0.123 } });
    const response = await addContribution(request(path, "POST", body), habitParams);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "precision", converted: 0.123 });
  });

  it("refuses with the reason and the habit as it is now", async () => {
    const habit = numericHabitSummary({ contributionBlock: "paused" });
    for (const [outcome, code] of [
      ["paused", "paused"],
      ["not_numeric", "not-numeric"],
      ["stale", "stale"],
      ["unit_mismatch", "unit-mismatch"],
      ["id_taken", "id-taken"],
      ["outside_window", "outside-window"],
    ] as const) {
      answers({ add_habit_contribution: { outcome, habit } });
      const response = await addContribution(request(path, "POST", body), habitParams);
      expect(response.status, outcome).toBe(409);
      expect(await response.json(), outcome).toMatchObject({ error: code });
    }
  });

  it("answers not found, not permitted, bad input, a cross-site and an anonymous request", async () => {
    answers({ add_habit_contribution: { outcome: "not_found" } });
    expect((await addContribution(request(path, "POST", body), habitParams)).status).toBe(404);
    answers({ add_habit_contribution: { outcome: "not_permitted" } });
    expect((await addContribution(request(path, "POST", body), habitParams)).status).toBe(403);
    state.rpc.mockClear();
    for (const bad of [
      { id: NEW_ID, quantity: "-1" },
      { id: NEW_ID, quantity: "1,5" },
      { id: NEW_ID, quantity: "1.2345" },
      { quantity: "250" },
      { ...body, source: "notification" },
    ]) {
      expect((await addContribution(request(path, "POST", bad), habitParams)).status).toBe(400);
    }
    expect(
      (await addContribution(request(path, "POST", body, crossSite), habitParams)).status,
    ).toBe(403);
    state.identity = null;
    expect((await addContribution(request(path, "POST", body), habitParams)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
    const gone = { params: Promise.resolve({ habitId: "not-an-id" }) };
    state.identity = { userId: "user-a" };
    expect((await addContribution(request(path, "POST", body), gone)).status).toBe(404);
  });
});

describe("undoing and correcting progress", () => {
  const path = `/habit-contributions/${CONTRIBUTION}`;
  const params = { params: Promise.resolve({ contributionId: CONTRIBUTION }) };

  it("undoes a contribution and answers the habit", async () => {
    answers({
      update_habit_contribution: {
        outcome: "undone",
        reopened: true,
        habit: numericHabitSummary(),
        streakBefore: 4,
      },
    });
    const response = await updateContribution(
      request(path, "PATCH", { action: "undo", reason: "oops" }),
      params,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("update_habit_contribution", {
      p_id: CONTRIBUTION,
      p_action: "undo",
      p_reason: "oops",
    });
  });

  it("amends with an exact new quantity, and only with one", async () => {
    answers({ update_habit_contribution: { outcome: "corrected" } });
    const response = await updateContribution(
      request(path, "PATCH", { action: "amend", quantity: "300" }),
      params,
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({ p_action: "amend", p_quantity: 300 });
    state.rpc.mockClear();
    expect(
      (await updateContribution(request(path, "PATCH", { action: "amend" }), params)).status,
    ).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses what is already undone, a stranger's undo and another member's contribution", async () => {
    answers({
      update_habit_contribution: { outcome: "already_undone", habit: numericHabitSummary() },
    });
    const done = await updateContribution(request(path, "PATCH", { action: "undo" }), params);
    expect(done.status).toBe(409);
    expect(await done.json()).toMatchObject({ error: "already-undone" });
    answers({ update_habit_contribution: { outcome: "not_permitted" } });
    expect(
      (await updateContribution(request(path, "PATCH", { action: "void" }), params)).status,
    ).toBe(403);
    answers({ update_habit_contribution: { outcome: "not_found" } });
    expect(
      (await updateContribution(request(path, "PATCH", { action: "undo" }), params)).status,
    ).toBe(404);
  });
});

describe("changing the tracking", () => {
  const path = `/habits/${HABIT}/tracking`;
  const base = {
    revision: 3,
    tracking: { ...tracking, target: "2500", quickAdds: [] },
    when: "next",
  };
  const impact = { effectiveOn: "2026-11-11", relation: "same" };

  it("previews without changing anything and sends exact values", async () => {
    answers({ change_habit_tracking: [{ outcome: "preview", impact, revision: 3 }] });
    const response = await changeTracking(
      request(path, "POST", { ...base, preview: true }),
      habitParams,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "preview", impact, revision: 3 });
    expect(state.rpc).toHaveBeenCalledWith("change_habit_tracking", {
      p_id: HABIT,
      p_expected_revision: 3,
      p_mode: "numeric",
      p_target: 2500,
      p_unit: "ml",
      p_unit_kind: "preset",
      p_when: "next",
      p_confirm_status: false,
      p_confirm_unit: false,
      p_dry_run: true,
    });
  });

  it("keeps the presets unless some are sent, and goes back to completing once", async () => {
    answers({ change_habit_tracking: [{ outcome: "saved", impact, revision: 4 }] });
    await changeTracking(
      request(path, "POST", { ...base, tracking: { ...base.tracking, quickAdds: ["100"] } }),
      habitParams,
    );
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({ p_quick_adds: [100] });
    await changeTracking(request(path, "POST", { ...base, tracking: null }), habitParams);
    const args = state.rpc.mock.calls[1]?.[1];
    expect(args).toMatchObject({ p_mode: "once" });
    expect(args).not.toHaveProperty("p_target");
  });

  it("sends today's total with a start today and the person's confirmations", async () => {
    answers({ change_habit_tracking: [{ outcome: "saved", impact, revision: 4 }] });
    await changeTracking(
      request(path, "POST", {
        ...base,
        when: "today",
        expectedTotal: 1500.5,
        confirmStatus: true,
        confirmUnit: true,
      }),
      habitParams,
    );
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_when: "today",
      p_expected_total: 1500.5,
      p_confirm_status: true,
      p_confirm_unit: true,
    });
  });

  it("answers the refusals that need an answer with the impact", async () => {
    for (const [outcome, code] of [
      ["confirm_unit", "confirm-unit"],
      ["confirm_status", "confirm-status"],
      ["stale", "stale"],
      ["today_ineligible", "today-ineligible"],
      ["numeric_requires_daily", "numeric-requires-daily"],
    ] as const) {
      answers({ change_habit_tracking: [{ outcome, impact, revision: 3 }] });
      const response = await changeTracking(request(path, "POST", base), habitParams);
      expect(response.status, outcome).toBe(409);
      expect(await response.json(), outcome).toMatchObject({ error: code, impact });
    }
  });

  it("answers a change that changes nothing, a date that is refused and a stale revision", async () => {
    answers({ change_habit_tracking: [{ outcome: "unchanged", impact, revision: 3 }] });
    const unchanged = await changeTracking(request(path, "POST", base), habitParams);
    expect(unchanged.status).toBe(409);
    expect(await unchanged.json()).toEqual({ error: "unchanged", revision: 3 });
    answers({
      change_habit_tracking: [
        { outcome: "invalid_date", impact: { earliest: "2026-11-11" }, revision: 3 },
      ],
    });
    const refused = await changeTracking(request(path, "POST", base), habitParams);
    expect(await refused.json()).toEqual({
      error: "invalid-dates",
      impact: { earliest: "2026-11-11" },
    });
    answers({ change_habit_tracking: [{ outcome: "conflict", impact: null, revision: 7 }] });
    const conflict = await changeTracking(request(path, "POST", base), habitParams);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict", revision: 7 });
  });

  it("refuses bad input and unauthorized requests before asking the database", async () => {
    for (const bad of [
      { ...base, when: "date" },
      { ...base, when: "yesterday" },
      { ...base, tracking: { ...base.tracking, target: "2,5" } },
      { ...base, revision: 0 },
    ]) {
      expect((await changeTracking(request(path, "POST", bad), habitParams)).status).toBe(400);
    }
    expect((await changeTracking(request(path, "POST", base, crossSite), habitParams)).status).toBe(
      403,
    );
    state.identity = null;
    expect((await changeTracking(request(path, "POST", base), habitParams)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("quick-add presets", () => {
  const path = `/habits/${HABIT}/quick-adds`;

  it("replaces the presets with exact numbers", async () => {
    answers({ set_habit_quick_adds: [{ outcome: "saved", revision: 5 }] });
    const response = await setQuickAdds(
      request(path, "PUT", { revision: 4, quickAdds: ["250", "0.5"] }),
      habitParams,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 5 });
    expect(state.rpc).toHaveBeenCalledWith("set_habit_quick_adds", {
      p_id: HABIT,
      p_expected_revision: 4,
      p_quick_adds: [250, 0.5],
    });
  });

  it("refuses too many presets and a habit that is not numeric", async () => {
    const tooMany = { revision: 4, quickAdds: ["1", "2", "3", "4", "5", "6"] };
    expect((await setQuickAdds(request(path, "PUT", tooMany), habitParams)).status).toBe(400);
    answers({ set_habit_quick_adds: [{ outcome: "not_numeric", revision: null }] });
    const response = await setQuickAdds(
      request(path, "PUT", { revision: 4, quickAdds: [] }),
      habitParams,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "not-numeric" });
  });
});

describe("daily totals, contributions and the day note", () => {
  const day = {
    onDate: "2026-11-09",
    state: "completed",
    pausedBy: null,
    target: 2000,
    unit: "ml",
    unitKind: "preset",
    total: 2250,
    met: true,
    above: true,
    note: null,
    noteRevision: 0,
    block: null,
  };

  it("reads a page of daily totals before a day", async () => {
    answers({ get_habit_daily_totals: { days: [day], hasMore: false } });
    const response = await readDays(
      request(`/habits/${HABIT}/days?before=2026-11-09`, "GET"),
      habitParams,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ totals: { days: [day], hasMore: false } });
    expect(state.rpc).toHaveBeenCalledWith("get_habit_daily_totals", {
      p_habit_id: HABIT,
      p_before: "2026-11-09",
    });
  });

  it("answers a page the shape does not match as unavailable, never as data", async () => {
    answers({ get_habit_daily_totals: { days: [{ ...day, total: "a lot" }], hasMore: false } });
    const response = await readDays(request(`/habits/${HABIT}/days`, "GET"), habitParams);
    expect(response.status).toBe(500);
  });

  it("reads a day's contributions, which the database limits to what the person may see", async () => {
    const contributions = {
      onDate: "2026-11-09",
      all: false,
      target: 2000,
      unit: "ml",
      unitKind: "preset",
      total: 500,
      contributions: [],
    };
    answers({ get_habit_contributions: contributions });
    const response = await readContributions(
      request(`/habits/${HABIT}/contributions?on=2026-11-09`, "GET"),
      habitParams,
    );
    expect(await response.json()).toEqual({ contributions });
    expect(
      (await readContributions(request(`/habits/${HABIT}/contributions`, "GET"), habitParams))
        .status,
    ).toBe(400);
    answers({ get_habit_contributions: null });
    expect(
      (
        await readContributions(
          request(`/habits/${HABIT}/contributions?on=2026-11-09`, "GET"),
          habitParams,
        )
      ).status,
    ).toBe(404);
  });

  it("sets and removes the day note with its revision", async () => {
    const path = `/habits/${HABIT}/day-notes/2026-11-09`;
    const params = { params: Promise.resolve({ habitId: HABIT, date: "2026-11-09" }) };
    answers({ set_habit_day_note: [{ outcome: "saved", revision: 2 }] });
    const saved = await setDayNote(request(path, "PUT", { revision: 1, note: "Hot day" }), params);
    expect(saved.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_habit_day_note", {
      p_habit_id: HABIT,
      p_on: "2026-11-09",
      p_expected_revision: 1,
      p_note: "Hot day",
    });
    await setDayNote(request(path, "PUT", { revision: 2, note: "  " }), params);
    expect(state.rpc.mock.calls[1]?.[1]).not.toHaveProperty("p_note");
    answers({ set_habit_day_note: [{ outcome: "conflict", revision: 3 }] });
    expect(
      (await setDayNote(request(path, "PUT", { revision: 1, note: "x" }), params)).status,
    ).toBe(409);
    answers({ set_habit_day_note: [{ outcome: "not_numeric", revision: null }] });
    const notNumeric = await setDayNote(request(path, "PUT", { revision: 1, note: "x" }), params);
    expect(await notNumeric.json()).toMatchObject({ error: "not-numeric" });
    const badDate = { params: Promise.resolve({ habitId: HABIT, date: "2026-13-40" }) };
    expect(
      (await setDayNote(request(path, "PUT", { revision: 1, note: "x" }), badDate)).status,
    ).toBe(404);
    expect(
      (await setDayNote(request(path, "PUT", { revision: 1, note: "x".repeat(281) }), params))
        .status,
    ).toBe(400);
  });
});
