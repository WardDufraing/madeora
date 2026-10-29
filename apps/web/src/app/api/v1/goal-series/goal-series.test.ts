// S30b: the recurring goal series routes. The database decides every right, period and outcome
// (tests/db/rls/recurring-goals.test.sql); these tests check what the routes send it and how they
// answer, including the refusals that carry what explains them.
import type { Mock } from "vitest";

import { GOAL, HOME, SERIES, goalSeriesDetail, goalSummary, goalPeriod } from "@/goals/testing";

import { GET as readPeriods } from "./[seriesId]/periods/route";
import { DELETE as remove, GET as readSeries, PATCH as update } from "./[seriesId]/route";
import { POST as setState } from "./[seriesId]/state/route";
import { POST as changeTarget } from "./[seriesId]/target/route";
import { POST as create } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

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
const seriesParams = { params: Promise.resolve({ seriesId: SERIES }) };

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

const newSeries = {
  id: SERIES,
  homeId: null,
  kind: "measurable",
  frequency: "monthly",
  title: "Run every month",
  measure: { target: "40", unit: "km", unitKind: "preset" },
  firstPeriod: "2026-11-10",
};

describe("checks every series mutation makes", () => {
  it("refuses a cross-site request and a signed-out person before the database", async () => {
    expect((await create(request("/goal-series", "POST", newSeries, crossSite))).status).toBe(403);
    state.identity = null;
    expect((await create(request("/goal-series", "POST", newSeries))).status).toBe(401);
    expect((await readSeries(request(`/goal-series/${SERIES}`, "GET"), seriesParams)).status).toBe(
      401,
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a weekly completion series, a missing measure and an end before the start", async () => {
    for (const body of [
      { ...newSeries, kind: "completion", measure: null, frequency: "weekly" },
      { ...newSeries, measure: null },
      { ...newSeries, endsOn: "2026-11-01" },
      { ...newSeries, frequency: "daily" },
      { ...newSeries, reminder: { leadDays: 0 } },
    ]) {
      expect((await create(request("/goal-series", "POST", body))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a malformed path id as not found without asking the database", async () => {
    const response = await setState(
      request("/goal-series/nope/state", "POST", { revision: 1, action: "pause" }),
      { params: Promise.resolve({ seriesId: "nope" }) },
    );
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("creating and reading series", () => {
  it("previews, then creates a personal series with exact numbers and the person's timezone", async () => {
    const periods = {
      first: { start: "2026-11-01", end: "2026-11-30" },
      next: { start: "2026-12-01", end: "2026-12-31" },
    };
    answers({ create_goal_series: { outcome: "preview", startsNow: true, periods } });
    const preview = await create(request("/goal-series", "POST", { ...newSeries, preview: true }));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ outcome: "preview", periods });
    expect(state.rpc).toHaveBeenCalledWith("create_goal_series", {
      p_id: SERIES,
      p_kind: "measurable",
      p_frequency: "monthly",
      p_title: "Run every month",
      p_target: 40,
      p_unit: "km",
      p_unit_kind: "preset",
      p_week_start: "monday",
      p_first_period: "2026-11-10",
      p_time_zone: "Europe/Brussels",
      p_dry_run: true,
    });
    answers({
      create_goal_series: { outcome: "created", revision: 1, currentGoalId: GOAL, startsNow: true },
    });
    const created = await create(
      request("/goal-series", "POST", {
        ...newSeries,
        homeId: HOME,
        endsOn: "2027-06-30",
        reminder: { leadDays: 3, atTime: "08:00" },
      }),
    );
    expect(created.status).toBe(201);
    expect(state.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
      p_home_id: HOME,
      p_ends_on: "2027-06-30",
      p_reminder_lead_days: 3,
      p_reminder_at_time: "08:00",
      p_dry_run: false,
    });
    expect(state.rpc.mock.calls.at(-1)?.[1]).not.toHaveProperty("p_time_zone");
  });

  it("answers the limit, a first period in the past and a refusal with their own codes", async () => {
    for (const [outcome, status, error] of [
      ["too_many", 409, "limit-reached"],
      ["invalid_dates", 409, "invalid-dates"],
      ["id_taken", 409, "id-taken"],
      ["not_permitted", 403, "not-permitted"],
    ] as const) {
      answers({ create_goal_series: { outcome } });
      const response = await create(request("/goal-series", "POST", newSeries));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
    }
  });

  it("rolls the series before reading it, and answers one the person may not see as not found", async () => {
    answers({ sync_goal_periods: 0, get_goal_series: goalSeriesDetail() });
    const response = await readSeries(request(`/goal-series/${SERIES}`, "GET"), seriesParams);
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "sync_goal_periods",
      "get_goal_series",
    ]);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({ p_series_id: SERIES });
    answers({ sync_goal_periods: 0, get_goal_series: null });
    expect((await readSeries(request(`/goal-series/${SERIES}`, "GET"), seriesParams)).status).toBe(
      404,
    );
  });

  it("still reads when the roll fails, and refuses an unexpected shape", async () => {
    answers({ get_goal_series: goalSeriesDetail() });
    expect((await readSeries(request(`/goal-series/${SERIES}`, "GET"), seriesParams)).status).toBe(
      200,
    );
    answers({ sync_goal_periods: 0, get_goal_series: { id: SERIES } });
    expect((await readSeries(request(`/goal-series/${SERIES}`, "GET"), seriesParams)).status).toBe(
      500,
    );
  });

  it("reads a page of periods after a cursor and refuses a malformed cursor", async () => {
    answers({
      get_goal_series_periods: {
        periods: [goalSummary({ period: goalPeriod({ ended: true, outcome: "reached" }) })],
        hasMore: false,
      },
    });
    const response = await readPeriods(
      request(`/goal-series/${SERIES}/periods?before=${GOAL}`, "GET"),
      seriesParams,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("get_goal_series_periods", {
      p_series_id: SERIES,
      p_before: GOAL,
    });
    expect(
      (await readPeriods(request(`/goal-series/${SERIES}/periods?before=x`, "GET"), seriesParams))
        .status,
    ).toBe(400);
  });
});

describe("changing a series", () => {
  const impact = {
    effectiveFrom: "2026-11-01",
    until: null,
    current: true,
    targetBefore: 10,
    targetAfter: 7,
    unitBefore: "km",
    unitKindBefore: "preset",
    unitAfter: "km",
    unitKindAfter: "preset",
    unitChanged: false,
    goalId: GOAL,
    total: 7.5,
    reachedBefore: false,
    reachedAfter: true,
    achieved: false,
    reopens: false,
    reminders: false,
  };
  const targetBody = {
    revision: 1,
    effectiveFrom: "2026-11-01",
    target: "7",
    unit: "km",
    unitKind: "preset",
  };

  it("previews a target change, then asks to confirm a flip of the current period", async () => {
    answers({ change_goal_series_target: { outcome: "preview", revision: 1, impact } });
    const preview = await changeTarget(
      request(`/goal-series/${SERIES}/target`, "POST", { ...targetBody, preview: true }),
      seriesParams,
    );
    expect(preview.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({
      p_id: SERIES,
      p_expected_revision: 1,
      p_effective_from: "2026-11-01",
      p_target: 7,
      p_unit: "km",
      p_unit_kind: "preset",
      p_dry_run: true,
      p_confirm_unit: false,
      p_confirm_status: false,
    });
    answers({ change_goal_series_target: { outcome: "confirm_status", revision: 1, impact } });
    const refused = await changeTarget(
      request(`/goal-series/${SERIES}/target`, "POST", targetBody),
      seriesParams,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: "confirm-status",
      impact: { reachedAfter: true },
    });
  });

  it("refuses a past period, a stopped series and a stale revision with their codes", async () => {
    for (const [outcome, error] of [
      ["invalid_period", "invalid-period"],
      ["stopped", "stopped"],
      ["conflict", "conflict"],
    ] as const) {
      answers({ change_goal_series_target: { outcome, revision: 2 } });
      const response = await changeTarget(
        request(`/goal-series/${SERIES}/target`, "POST", targetBody),
        seriesParams,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error });
    }
  });

  it("pauses, resumes and stops with the revision as read; a stopped series answers 409", async () => {
    answers({ set_goal_series_state: [{ outcome: "saved", revision: 2 }] });
    const paused = await setState(
      request(`/goal-series/${SERIES}/state`, "POST", { revision: 1, action: "pause" }),
      seriesParams,
    );
    expect(paused.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_goal_series_state", {
      p_id: SERIES,
      p_expected_revision: 1,
      p_action: "pause",
    });
    answers({ set_goal_series_state: [{ outcome: "stopped", revision: 3 }] });
    const refused = await setState(
      request(`/goal-series/${SERIES}/state`, "POST", { revision: 3, action: "resume" }),
      seriesParams,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "stopped" });
    expect(
      (
        await setState(
          request(`/goal-series/${SERIES}/state`, "POST", { revision: 3, action: "restart" }),
          seriesParams,
        )
      ).status,
    ).toBe(400);
  });

  it("edits for later periods and deletes with the revision as read", async () => {
    answers({ update_goal_series: [{ outcome: "saved", revision: 2 }] });
    const edited = await update(
      request(`/goal-series/${SERIES}`, "PATCH", {
        revision: 1,
        title: "Run more",
        endsOn: "2027-12-31",
        reminder: null,
      }),
      seriesParams,
    );
    expect(edited.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("update_goal_series", {
      p_id: SERIES,
      p_expected_revision: 1,
      p_title: "Run more",
      p_ends_on: "2027-12-31",
    });
    answers({ delete_goal_series: [{ outcome: "deleted", entry_id: GOAL }] });
    const deleted = await remove(
      request(`/goal-series/${SERIES}`, "DELETE", { revision: 2 }),
      seriesParams,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: SERIES, entryId: GOAL });
  });
});
