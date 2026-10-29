// S30: the goal routes. The database decides every right, total and state
// (tests/db/rls/goals.test.sql); these tests check what the routes send it and how they answer,
// including the refusals that carry what explains them.
import type { Mock } from "vitest";

import { GOAL, ENTRY, HOME, goalDetail, goalList, goalSummary } from "@/goals/testing";

import { PATCH as correctEntry } from "../goal-entries/[entryId]/route";
import { POST as setAchievement } from "./[goalId]/achievement/route";
import { POST as archive } from "./[goalId]/archive/route";
import { GET as readEntries, POST as addEntry } from "./[goalId]/entries/route";
import { GET as readHistory } from "./[goalId]/history/route";
import { PUT as setMyReminders } from "./[goalId]/my-reminders/route";
import { PUT as setReminders } from "./[goalId]/reminders/route";
import { DELETE as remove, GET as readGoal, PATCH as update } from "./[goalId]/route";
import { POST as changeTarget } from "./[goalId]/target/route";
import { GET as list, POST as create } from "./route";
import { PATCH as settings } from "./settings/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const NEW_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00d2";

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
const goalParams = { params: Promise.resolve({ goalId: GOAL }) };

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

const newGoal = {
  id: GOAL,
  homeId: null,
  kind: "measurable",
  title: "Read books",
  measure: { target: "12", unit: "books", unitKind: "custom" },
  initial: "2",
};

describe("checks every mutation makes", () => {
  it("refuses a cross-site request and a signed-out person before the database", async () => {
    expect((await create(request("/goals", "POST", newGoal, crossSite))).status).toBe(403);
    state.identity = null;
    expect((await create(request("/goals", "POST", newGoal))).status).toBe(401);
    expect((await readGoal(request(`/goals/${GOAL}`, "GET"), goalParams)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a malformed path id as not found without asking the database", async () => {
    const response = await addEntry(
      request("/goals/nope/entries", "POST", { id: NEW_ID, quantity: "1" }),
      { params: Promise.resolve({ goalId: "nope" }) },
    );
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps a Home the person is not in to not found and bad input to 400", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await create(request("/goals", "POST", { ...newGoal, homeId: HOME }))).status).toBe(
      404,
    );
    state.rpc.mockReturnValue({ data: null, error: { code: "22023", message: "invalid goal" } });
    expect((await create(request("/goals", "POST", newGoal))).status).toBe(400);
  });
});

describe("creating and reading goals", () => {
  it("sends exact numbers, the custom unit and the person's timezone for a personal goal", async () => {
    answers({ create_goal: [{ outcome: "created", revision: 1 }] });
    const response = await create(request("/goals", "POST", newGoal));
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_goal", {
      p_id: GOAL,
      p_kind: "measurable",
      p_title: "Read books",
      p_target: 12,
      p_unit: "books",
      p_unit_kind: "custom",
      p_initial: 2,
      p_time_zone: "Europe/Brussels",
    });
  });

  it("sends a Home goal without a timezone, and a renewal with its source", async () => {
    answers({ create_goal: [{ outcome: "created", revision: 1 }] });
    await create(
      request("/goals", "POST", {
        id: NEW_ID,
        homeId: HOME,
        kind: "completion",
        title: "Paint the shed",
        renewedFrom: GOAL,
      }),
    );
    const args = state.rpc.mock.calls[0]?.[1];
    expect(args).toMatchObject({ p_home_id: HOME, p_renewed_from: GOAL });
    expect(args).not.toHaveProperty("p_time_zone");
    expect(args).not.toHaveProperty("p_target");
  });

  it("answers the limit, a past deadline and a refusal with their own codes", async () => {
    for (const [outcome, status, error] of [
      ["too_many", 409, "limit-reached"],
      ["invalid_dates", 409, "invalid-dates"],
      ["not_permitted", 403, "not-permitted"],
      ["id_taken", 409, "id-taken"],
    ] as const) {
      answers({ create_goal: [{ outcome, revision: null }] });
      const response = await create(request("/goals", "POST", newGoal));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("reads a list and one goal through the shape check", async () => {
    answers({ get_goals: goalList(), get_goal: goalDetail() });
    const listed = await list(request(`/goals?homeId=${HOME}&view=completed&q=walk`, "GET"));
    expect(listed.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({
      p_home_id: HOME,
      p_view: "completed",
      p_query: "walk",
    });
    const one = await readGoal(request(`/goals/${GOAL}`, "GET"), goalParams);
    expect(((await one.json()) as { goal: { id: string } }).goal.id).toBe(GOAL);
  });

  it("answers a goal the person may not see as not found", async () => {
    answers({ get_goal: null });
    expect((await readGoal(request(`/goals/${GOAL}`, "GET"), goalParams)).status).toBe(404);
  });

  it("refuses an unknown view", async () => {
    expect((await list(request("/goals?view=everything", "GET"))).status).toBe(400);
  });
});

describe("progress", () => {
  const path = `/goals/${GOAL}/entries`;

  it("adds exactly what was sent", async () => {
    answers({
      add_goal_entry: { outcome: "added", entryId: NEW_ID, totalBefore: 7.5, goal: goalSummary() },
    });
    const response = await addEntry(
      request(path, "POST", { id: NEW_ID, quantity: "0.1" }),
      goalParams,
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({
      p_id: NEW_ID,
      p_goal_id: GOAL,
      p_mode: "add",
      p_quantity: 0.1,
      p_source: "app",
    });
  });

  it("sets a total with the total the person saw, and answers a moved total as stale", async () => {
    answers({ add_goal_entry: { outcome: "stale", goal: goalSummary({ total: 8 }) } });
    const response = await addEntry(
      request(path, "POST", { id: NEW_ID, mode: "total", quantity: "10", expectedTotal: "7.5" }),
      goalParams,
    );
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({ p_mode: "total", p_expected_total: 7.5 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "stale", goal: { total: 8 } });
  });

  it("refuses progress on an achieved goal", async () => {
    answers({ add_goal_entry: { outcome: "achieved", goal: goalSummary({ status: "achieved" }) } });
    const response = await addEntry(
      request(path, "POST", { id: NEW_ID, quantity: "1" }),
      goalParams,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "achieved" });
  });

  it("reads a page of entries after a cursor", async () => {
    answers({ get_goal_entries: { entries: [], hasMore: false } });
    const response = await readEntries(request(`${path}?before=${ENTRY}`, "GET"), goalParams);
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({ p_goal_id: GOAL, p_before: ENTRY });
  });

  it("corrects an entry and refuses one that would take the total below 0", async () => {
    const entryParams = { params: Promise.resolve({ entryId: ENTRY }) };
    answers({ update_goal_entry: { outcome: "corrected", totalBefore: 7.5, goal: goalSummary() } });
    const amended = await correctEntry(
      request(`/goal-entries/${ENTRY}`, "PATCH", {
        action: "amend",
        quantity: "-1",
        reason: "typo",
      }),
      entryParams,
    );
    expect(amended.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({
      p_id: ENTRY,
      p_action: "amend",
      p_quantity: -1,
      p_reason: "typo",
    });
    answers({ update_goal_entry: { outcome: "negative_total", goal: goalSummary() } });
    const refused = await correctEntry(
      request(`/goal-entries/${ENTRY}`, "PATCH", { action: "reverse" }),
      entryParams,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "negative-total" });
  });
});

describe("target, achievement and archive", () => {
  const impact = {
    targetBefore: 10,
    targetAfter: 12,
    unitBefore: "km",
    unitKindBefore: "preset",
    unitAfter: "m",
    unitKindAfter: "preset",
    unitChanged: true,
    total: 7.5,
    reachedBefore: false,
    reachedAfter: false,
    achieved: false,
    reopens: false,
  };

  it("previews a target change and asks to confirm a unit change with the impact", async () => {
    answers({ change_goal_target: { outcome: "preview", revision: 3, impact } });
    const body = { revision: 3, target: "12", unit: "m", unitKind: "preset", preview: true };
    const preview = await changeTarget(request(`/goals/${GOAL}/target`, "POST", body), goalParams);
    expect(preview.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({ p_dry_run: true, p_target: 12 });
    answers({ change_goal_target: { outcome: "confirm_unit", revision: 3, impact } });
    const refused = await changeTarget(
      request(`/goals/${GOAL}/target`, "POST", { ...body, preview: false }),
      goalParams,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "confirm-unit", impact: { total: 7.5 } });
  });

  it("answers a conflict with the current revision", async () => {
    answers({ set_goal_achievement: { outcome: "conflict", revision: 5 } });
    const response = await setAchievement(
      request(`/goals/${GOAL}/achievement`, "POST", { revision: 3, achieved: true }),
      goalParams,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", revision: 5 });
  });

  it("refuses to achieve below the target and reopens with a reason", async () => {
    answers({ set_goal_achievement: { outcome: "target_not_reached", goal: goalSummary() } });
    const refused = await setAchievement(
      request(`/goals/${GOAL}/achievement`, "POST", { revision: 3, achieved: true }),
      goalParams,
    );
    expect(await refused.json()).toMatchObject({ error: "target-not-reached" });
    answers({ set_goal_achievement: { outcome: "reopened", revision: 4, goal: goalSummary() } });
    const reopened = await setAchievement(
      request(`/goals/${GOAL}/achievement`, "POST", {
        revision: 3,
        achieved: false,
        reason: "Counted twice",
      }),
      goalParams,
    );
    expect(reopened.status).toBe(200);
    expect(state.rpc.mock.calls.at(-1)?.[1]).toEqual({
      p_id: GOAL,
      p_expected_revision: 3,
      p_achieved: false,
      p_reason: "Counted twice",
    });
  });

  it("archives, edits and deletes with the revision as read", async () => {
    answers({
      archive_goal: [{ outcome: "saved", revision: 4 }],
      update_goal: [{ outcome: "saved", revision: 4 }],
      delete_goal: [{ outcome: "deleted", entry_id: ENTRY }],
    });
    expect(
      (
        await archive(
          request(`/goals/${GOAL}/archive`, "POST", { revision: 3, archived: true }),
          goalParams,
        )
      ).status,
    ).toBe(200);
    const edited = await update(
      request(`/goals/${GOAL}`, "PATCH", { revision: 3, title: "Walk", deadline: null }),
      goalParams,
    );
    expect(edited.status).toBe(200);
    expect(state.rpc.mock.calls[1]?.[1]).not.toHaveProperty("p_deadline");
    const deleted = await remove(request(`/goals/${GOAL}`, "DELETE", { revision: 4 }), goalParams);
    expect(await deleted.json()).toEqual({ id: GOAL, entryId: ENTRY });
  });
});

describe("reminders, settings and history", () => {
  it("previews the moments and answers a goal without a deadline", async () => {
    answers({
      set_goal_reminders: {
        outcome: "preview",
        revision: 0,
        moments: [{ kind: "lead", at: "2026-12-28T08:00:00Z", passed: false }],
      },
    });
    const body = {
      expectedRevision: 0,
      enabled: true,
      leadDays: 3,
      atTime: "09:00",
      preview: true,
    };
    const preview = await setReminders(
      request(`/goals/${GOAL}/reminders`, "PUT", body),
      goalParams,
    );
    expect(preview.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({
      p_id: GOAL,
      p_expected_revision: 0,
      p_enabled: true,
      p_lead_days: 3,
      p_at_time: "09:00",
      p_dry_run: true,
    });
    answers({ set_goal_reminders: { outcome: "no_deadline" } });
    const refused = await setReminders(
      request(`/goals/${GOAL}/reminders`, "PUT", { ...body, preview: false }),
      goalParams,
    );
    expect(await refused.json()).toEqual({ error: "no-deadline" });
  });

  it("turns a Home goal's reminders off for the person and sets member access", async () => {
    answers({ set_my_goal_reminders: "saved", update_goal_settings: "saved" });
    expect(
      (
        await setMyReminders(
          request(`/goals/${GOAL}/my-reminders`, "PUT", { enabled: false }),
          goalParams,
        )
      ).status,
    ).toBe(200);
    expect(
      (await settings(request("/goals/settings", "PATCH", { homeId: HOME, memberAccess: "view" })))
        .status,
    ).toBe(200);
    expect(
      (
        await settings(
          request("/goals/settings", "PATCH", { homeId: HOME, memberAccess: "manage" }),
        )
      ).status,
    ).toBe(400);
  });

  it("reads the history through the shape check", async () => {
    answers({
      get_goal_events: {
        events: [
          {
            id: ENTRY,
            kind: "achieved",
            by: null,
            mine: true,
            at: "2026-11-10T10:00:00Z",
            entryId: null,
            details: { total: 10, target: 10 },
          },
        ],
        hasMore: false,
      },
    });
    const response = await readHistory(request(`/goals/${GOAL}/history`, "GET"), goalParams);
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { history: { events: unknown[] } }).history.events,
    ).toHaveLength(1);
  });
});
