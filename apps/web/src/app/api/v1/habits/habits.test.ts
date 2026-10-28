// S28: the habit routes. The database decides rights, schedules, streaks and pauses
// (tests/db/rls/habits.test.sql); these tests check what the routes send it and how they answer.
import type { Mock } from "vitest";

import type { HabitSummary } from "@/habits/shapes";
import { CHECKIN, HABIT, HOME, habitCheckin, habitSummary } from "@/habits/testing";

import { POST as undo } from "../habit-checkins/[checkinId]/undo/route";
import { POST as snooze } from "../habit-reminders/[notificationId]/snooze/route";
import { POST as complete } from "./[habitId]/checkins/route";
import { POST as pause } from "./[habitId]/pauses/route";
import { POST as create } from "./route";
import { PATCH as settings } from "./settings/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const NOTICE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0090";

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
const params = <K extends string>(key: K, value: string) => ({
  params: Promise.resolve({ [key]: value } as Record<K, string>),
});

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

const newHabit = {
  id: HABIT,
  homeId: null,
  name: "  Morning   walk ",
  description: "",
  schedule: { kind: "weekdays", weekdays: [1, 3, 5] },
  startsOn: "2026-11-10",
  weekStart: "monday",
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("creating a habit", () => {
  it("trims the name, gives a personal habit the person's timezone and sends only what is set", async () => {
    answers({ create_habit: [{ outcome: "created", revision: 1 }] });
    const response = await create(request("/habits", "POST", newHabit));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ id: HABIT, revision: 1 });
    expect(state.rpc).toHaveBeenCalledWith("create_habit", {
      p_id: HABIT,
      p_name: "Morning   walk",
      p_kind: "weekdays",
      p_weekdays: [1, 3, 5],
      p_starts_on: "2026-11-10",
      p_time_zone: "Europe/Brussels",
      p_week_start: "monday",
    });
  });

  it("sends a Home habit without a timezone (the Home's own)", async () => {
    answers({ create_habit: [{ outcome: "created", revision: 1 }] });
    await create(request("/habits", "POST", { ...newHabit, homeId: HOME, timeZone: "Asia/Tokyo" }));
    const args = state.rpc.mock.calls[0]?.[1];
    expect(args?.p_home_id).toBe(HOME);
    expect(args).not.toHaveProperty("p_time_zone");
  });

  it("refuses an invalid schedule, a cross-site request and an anonymous one", async () => {
    for (const schedule of [
      { kind: "weekdays", weekdays: [] },
      { kind: "weekly", target: 8 },
      { kind: "daily", target: 2 },
    ]) {
      expect((await create(request("/habits", "POST", { ...newHabit, schedule }))).status).toBe(
        400,
      );
    }
    expect((await create(request("/habits", "POST", newHabit, crossSite))).status).toBe(403);
    state.identity = null;
    expect((await create(request("/habits", "POST", newHabit))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a Home the person does not belong to as not found, and the limit as 409", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await create(request("/habits", "POST", { ...newHabit, homeId: HOME }))).status).toBe(
      404,
    );
    answers({ create_habit: [{ outcome: "too_many", revision: null }] });
    const limited = await create(request("/habits", "POST", newHabit));
    expect(limited.status).toBe(409);
    expect(await limited.json()).toEqual({ error: "limit-reached" });
  });
});

describe("checking in", () => {
  const path = `/habits/${HABIT}/checkins`;

  it("sends no date for the habit's today and answers the check-in and the habit", async () => {
    const habit = habitSummary({ todayState: "completed", todayCheckin: habitCheckin() });
    answers({
      complete_habit: {
        outcome: "completed",
        checkin: habitCheckin(),
        streakBefore: 2,
        milestone: null,
        habit,
      },
    });
    const response = await complete(
      request(path, "POST", { id: CHECKIN, source: "notification" }),
      params("habitId", HABIT),
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("complete_habit", {
      p_checkin_id: CHECKIN,
      p_habit_id: HABIT,
      p_source: "notification",
    });
    const body = (await response.json()) as { habit: HabitSummary };
    expect(body.habit.streak.current).toBe(3);
  });

  it("sends a backdated day and a note", async () => {
    answers({ complete_habit: { outcome: "completed", checkin: habitCheckin() } });
    await complete(
      request(path, "POST", { id: CHECKIN, onDate: "2026-11-05", note: " Felt good " }),
      params("habitId", HABIT),
    );
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_on: "2026-11-05",
      p_note: " Felt good ",
      p_source: "app",
    });
  });

  it("answers a paused day, a repeat and a day out of reach as 409 with the habit", async () => {
    const habit = habitSummary();
    for (const outcome of ["paused", "already_completed", "outside_window", "not_scheduled"]) {
      answers({ complete_habit: { outcome, checkin: null, habit } });
      const response = await complete(
        request(path, "POST", { id: CHECKIN }),
        params("habitId", HABIT),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string; habit: HabitSummary };
      expect(body.error).toBe(outcome.replaceAll("_", "-"));
      expect(body.habit.id).toBe(HABIT);
    }
  });

  it("refuses an id that is not a uuid, a bad date and an unexpected answer", async () => {
    expect(
      (await complete(request(path, "POST", { id: CHECKIN }), params("habitId", "walk"))).status,
    ).toBe(404);
    expect(
      (
        await complete(
          request(path, "POST", { id: CHECKIN, onDate: "2026-02-30" }),
          params("habitId", HABIT),
        )
      ).status,
    ).toBe(400);
    answers({ complete_habit: { outcome: "completed", checkin: { id: "x" } } });
    expect(
      (await complete(request(path, "POST", { id: CHECKIN }), params("habitId", HABIT))).status,
    ).toBe(500);
  });
});

describe("undoing a check-in", () => {
  it("sends the reason only when there is one", async () => {
    answers({
      undo_habit_checkin: {
        outcome: "undone",
        checkin: habitCheckin({ status: "undone", undoKind: "correction" }),
      },
    });
    const path = `/habit-checkins/${CHECKIN}/undo`;
    expect(
      (await undo(request(path, "POST", { reason: "Wrong day" }), params("checkinId", CHECKIN)))
        .status,
    ).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("undo_habit_checkin", {
      p_checkin_id: CHECKIN,
      p_reason: "Wrong day",
    });
    await undo(request(path, "POST", { reason: "  " }), params("checkinId", CHECKIN));
    expect(state.rpc).toHaveBeenLastCalledWith("undo_habit_checkin", { p_checkin_id: CHECKIN });
    answers({ undo_habit_checkin: { outcome: "not_permitted" } });
    expect((await undo(request(path, "POST", {}), params("checkinId", CHECKIN))).status).toBe(403);
  });
});

describe("pausing", () => {
  it("answers a started pause as success, not as a paused-day refusal", async () => {
    answers({ pause_habit: [{ outcome: "paused", impact: { days: 3 }, revision: 2 }] });
    const response = await pause(
      request(`/habits/${HABIT}/pauses`, "POST", { revision: 1, resumesOn: "2026-11-14" }),
      params("habitId", HABIT),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "paused",
      impact: { days: 3 },
      revision: 2,
    });
    expect(state.rpc).toHaveBeenCalledWith("pause_habit", {
      p_id: HABIT,
      p_expected_revision: 1,
      p_resumes_on: "2026-11-14",
      p_dry_run: false,
    });
  });

  it("answers a stale revision with the current one", async () => {
    answers({ pause_habit: [{ outcome: "conflict", impact: null, revision: 4 }] });
    const response = await pause(
      request(`/habits/${HABIT}/pauses`, "POST", { revision: 1 }),
      params("habitId", HABIT),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", revision: 4 });
  });
});

describe("snoozing a reminder", () => {
  const path = `/habit-reminders/${NOTICE}/snooze`;

  it("accepts 15, 30 or 60 minutes and answers when it comes back", async () => {
    answers({ snooze_habit_reminder: [{ outcome: "snoozed", due_at: "2026-11-10T08:30:00Z" }] });
    const response = await snooze(
      request(path, "POST", { minutes: 30 }),
      params("notificationId", NOTICE),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dueAt: "2026-11-10T08:30:00Z" });
    expect(
      (await snooze(request(path, "POST", { minutes: 45 }), params("notificationId", NOTICE)))
        .status,
    ).toBe(400);
  });

  it("refuses quiet hours and a closed day as 409", async () => {
    for (const outcome of ["quiet_hours", "window_closed", "already_snoozed"]) {
      answers({ snooze_habit_reminder: [{ outcome, due_at: null }] });
      const response = await snooze(
        request(path, "POST", { minutes: 15 }),
        params("notificationId", NOTICE),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: outcome.replaceAll("_", "-") });
    }
  });
});

describe("habit settings", () => {
  it("sets celebrations for the person, or member access for a Home", async () => {
    answers({ set_habit_celebrations: "saved", update_habit_settings: "saved" });
    expect(
      (await settings(request("/habits/settings", "PATCH", { celebrations: false }))).status,
    ).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("set_habit_celebrations", { p_enabled: false });
    expect(
      (await settings(request("/habits/settings", "PATCH", { homeId: HOME, memberAccess: "view" })))
        .status,
    ).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("update_habit_settings", {
      p_home_id: HOME,
      p_member_access: "view",
    });
  });

  it("refuses an unknown access level and a mixed body", async () => {
    for (const body of [
      { homeId: HOME, memberAccess: "manage" },
      { homeId: HOME, memberAccess: "view", celebrations: true },
    ]) {
      expect((await settings(request("/habits/settings", "PATCH", body))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
