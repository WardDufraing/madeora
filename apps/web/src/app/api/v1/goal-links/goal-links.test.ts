// S30c: the habit-to-goal link routes. The database decides every right, unit, amount and recompute
// (tests/db/rls/habit-goal-links.test.sql); these tests check what the routes send it and how they
// answer, including a stale confirmation that carries the new preview.
import type { Mock } from "vitest";

import { GOAL, HABIT, LINK, SERIES, goalLink, goalLinkImpact } from "@/goals/testing";

import { POST as unlink } from "./[linkId]/unlink/route";
import { PATCH as changeStart } from "./[linkId]/route";
import { GET as readCandidates } from "./candidates/route";
import { GET as readLinks, POST as create } from "./route";

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
const linkParams = { params: Promise.resolve({ linkId: LINK }) };

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

const newLink = { id: LINK, habitId: HABIT, goalId: GOAL, start: "beginning" };

describe("checks every link request makes", () => {
  it("refuses a cross-site request and a signed-out person before the database", async () => {
    expect((await create(request("/goal-links", "POST", newLink, crossSite))).status).toBe(403);
    state.identity = null;
    expect((await create(request("/goal-links", "POST", newLink))).status).toBe(401);
    expect((await readLinks(request(`/goal-links?goalId=${GOAL}`, "GET"))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses two destinations, a date without the date and a confirmation without the preview's numbers", async () => {
    for (const body of [
      { ...newLink, seriesId: SERIES },
      { ...newLink, goalId: null },
      { ...newLink, start: "date" },
      { ...newLink, start: "today", startDate: "2026-11-01" },
      { ...newLink, start: "yesterday" },
      { ...newLink, revision: 1 },
      { ...newLink, expectedAmount: "6" },
    ]) {
      expect((await create(request("/goal-links", "POST", body))).status).toBe(400);
    }
    expect(
      (
        await unlink(
          request(`/goal-links/${LINK}/unlink`, "POST", { mode: "drop", preview: true }),
          linkParams,
        )
      ).status,
    ).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("lists exactly one goal's, series' or habit's links", async () => {
    expect((await readLinks(request("/goal-links", "GET"))).status).toBe(400);
    expect(
      (await readLinks(request(`/goal-links?goalId=${GOAL}&habitId=${HABIT}`, "GET"))).status,
    ).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a malformed path id as not found without asking the database", async () => {
    const response = await changeStart(
      request("/goal-links/nope", "PATCH", { start: "today", preview: true }),
      { params: Promise.resolve({ linkId: "nope" }) },
    );
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("reading links", () => {
  it("answers a goal's links and a habit's linked goals", async () => {
    answers({ get_goal_links: { links: [goalLink()] } });
    const goal = await readLinks(request(`/goal-links?goalId=${GOAL}`, "GET"));
    expect(goal.status).toBe(200);
    expect(await goal.json()).toEqual({ links: [goalLink()] });
    expect(state.rpc).toHaveBeenLastCalledWith("get_goal_links", { p_goal_id: GOAL });
    await readLinks(request(`/goal-links?habitId=${HABIT}`, "GET"));
    expect(state.rpc).toHaveBeenLastCalledWith("get_goal_links", { p_habit_id: HABIT });
    await readLinks(request(`/goal-links?seriesId=${SERIES}`, "GET"));
    expect(state.rpc).toHaveBeenLastCalledWith("get_goal_links", { p_series_id: SERIES });
  });

  it("answers what the person may not see as not found", async () => {
    answers({ get_goal_links: null });
    expect((await readLinks(request(`/goal-links?goalId=${GOAL}`, "GET"))).status).toBe(404);
  });

  it("refuses a database answer of the wrong shape", async () => {
    answers({ get_goal_links: { links: [{ id: "x" }] } });
    expect((await readLinks(request(`/goal-links?goalId=${GOAL}`, "GET"))).status).toBe(500);
  });

  it("lists the habits a series could link", async () => {
    const habits = [
      {
        id: HABIT,
        name: "Run",
        unit: "km",
        unitKind: "preset",
        firstStart: "2026-10-01",
        today: "2026-11-10",
      },
    ];
    answers({ get_goal_link_candidates: { habits } });
    const response = await readCandidates(
      request(`/goal-links/candidates?seriesId=${SERIES}`, "GET"),
    );
    expect(await response.json()).toEqual({ habits });
    expect(state.rpc).toHaveBeenCalledWith("get_goal_link_candidates", { p_series_id: SERIES });
  });
});

describe("linking", () => {
  it("previews, then confirms with the preview's revision and amount", async () => {
    answers({ create_goal_link: { outcome: "preview", revision: 3, impact: goalLinkImpact() } });
    const preview = await create(request("/goal-links", "POST", { ...newLink, preview: true }));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ outcome: "preview", revision: 3 });
    expect(state.rpc).toHaveBeenLastCalledWith("create_goal_link", {
      p_id: LINK,
      p_habit_id: HABIT,
      p_goal_id: GOAL,
      p_start: "beginning",
      p_dry_run: true,
    });
    answers({
      create_goal_link: { outcome: "created", link: goalLink(), impact: goalLinkImpact() },
    });
    const created = await create(
      request("/goal-links", "POST", { ...newLink, revision: 3, expectedAmount: "6" }),
    );
    expect(created.status).toBe(201);
    expect(state.rpc).toHaveBeenLastCalledWith("create_goal_link", {
      p_id: LINK,
      p_habit_id: HABIT,
      p_goal_id: GOAL,
      p_start: "beginning",
      p_dry_run: false,
      p_expected_revision: 3,
      p_expected_amount: 6,
    });
  });

  it("sends a chosen date and a series", async () => {
    answers({ create_goal_link: { outcome: "preview", revision: 1, impact: goalLinkImpact() } });
    await create(
      request("/goal-links", "POST", {
        id: LINK,
        habitId: HABIT,
        seriesId: SERIES,
        start: "date",
        startDate: "2026-10-15",
        preview: true,
      }),
    );
    expect(state.rpc).toHaveBeenLastCalledWith("create_goal_link", {
      p_id: LINK,
      p_habit_id: HABIT,
      p_series_id: SERIES,
      p_start: "date",
      p_start_date: "2026-10-15",
      p_dry_run: true,
    });
  });

  it("answers a stale confirmation with the new revision and preview", async () => {
    const impact = goalLinkImpact({ amountAfter: 7 });
    answers({ create_goal_link: { outcome: "stale", revision: 4, impact } });
    const response = await create(
      request("/goal-links", "POST", { ...newLink, revision: 3, expectedAmount: "6" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stale", revision: 4, impact });
  });

  it.each([
    ["already_linked", 409, "already-linked"],
    ["incompatible_unit", 409, "incompatible-unit"],
    ["not_numeric", 409, "not-numeric"],
    ["other_context", 409, "other-context"],
    ["invalid_start", 409, "invalid-start"],
    ["habit_archived", 409, "habit-archived"],
    ["series_period", 409, "series-period"],
    ["too_many", 409, "limit-reached"],
    ["not_permitted", 403, "not-permitted"],
    ["not_found", 404, "not-found"],
  ])("answers %s as %i %s", async (outcome, status, error) => {
    answers({ create_goal_link: { outcome } });
    const response = await create(request("/goal-links", "POST", { ...newLink, preview: true }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
  });

  it("maps a refused field to 400 and an unexpected database error to 500", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "22023", message: "invalid link" } });
    expect(
      (await create(request("/goal-links", "POST", { ...newLink, preview: true }))).status,
    ).toBe(400);
    state.rpc.mockReturnValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect(
      (await create(request("/goal-links", "POST", { ...newLink, preview: true }))).status,
    ).toBe(500);
  });
});

describe("changing and removing links", () => {
  it("previews and saves a new start", async () => {
    answers({
      change_goal_link_start: { outcome: "saved", link: goalLink(), impact: goalLinkImpact() },
    });
    const response = await changeStart(
      request(`/goal-links/${LINK}`, "PATCH", { start: "today", revision: 1, expectedAmount: 2.5 }),
      linkParams,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("change_goal_link_start", {
      p_id: LINK,
      p_start: "today",
      p_dry_run: false,
      p_expected_revision: 1,
      p_expected_amount: 2.5,
    });
  });

  it("answers a habit that can no longer change", async () => {
    answers({ change_goal_link_start: { outcome: "source_unavailable" } });
    const response = await changeStart(
      request(`/goal-links/${LINK}`, "PATCH", { start: "today", preview: true }),
      linkParams,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "source-unavailable" });
  });

  it("removes a link keeping its amount", async () => {
    answers({ remove_goal_link: { outcome: "removed", impact: goalLinkImpact({ mode: "keep" }) } });
    const response = await unlink(
      request(`/goal-links/${LINK}/unlink`, "POST", {
        mode: "keep",
        revision: 2,
        expectedAmount: "4.5",
      }),
      linkParams,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("remove_goal_link", {
      p_id: LINK,
      p_mode: "keep",
      p_dry_run: false,
      p_expected_revision: 2,
      p_expected_amount: 4.5,
    });
  });
});
