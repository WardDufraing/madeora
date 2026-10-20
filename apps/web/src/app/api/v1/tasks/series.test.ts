// S19: the recurring-task routes. The database decides scopes, impact and rights (tests/db/rls/
// task-recurrence.test.sql); these tests check what the routes send it and how they answer.
import type { Mock } from "vitest";

import { DELETE as deleteList } from "../task-lists/[listId]/route";
import { GET as occurrences } from "./[taskId]/occurrences/route";
import { POST as removeSeries } from "./[taskId]/series/delete/route";
import { PUT as pauseSeries } from "./[taskId]/series/paused/route";
import { POST as changeSeries } from "./[taskId]/series/route";
import { POST as createTask } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const SERIES = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0015";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0090";

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
const today = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown;

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

const weekly = {
  frequency: "weekly",
  interval: 2,
  weekdays: [4, 1],
  startsOn: "2026-10-19",
  endsOn: null,
  count: 10,
};
const newSeries = {
  id: SERIES,
  homeId: HOME,
  listId: LIST,
  title: " Water the plants ",
  description: null,
  startDate: "2026-10-17",
  dueDate: "2026-10-19",
  priority: null,
  labelIds: [],
  assigneeIds: [MEMBER],
  recurrence: weekly,
};
const change = {
  scope: "following",
  expectedTaskRevision: 2,
  expectedSeriesRevision: 4,
  dryRun: true,
  content: {
    title: "Water all the plants",
    description: null,
    priority: "high",
    labelIds: [],
    startOffset: 1,
    copySubtasks: true,
  },
};
const impact = {
  scope: "following",
  updated: 3,
  kept: 1,
  removed: 0,
  completed: 2,
  selectedRemoved: false,
  subtasksCopied: 2,
  nextDates: ["2026-10-22"],
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("every recurring-task mutation", () => {
  const calls: readonly [string, () => Promise<Response>][] = [
    ["create series", () => createTask(request("/tasks", "POST", newSeries, crossSite))],
    [
      "change series",
      () =>
        changeSeries(
          request(`/tasks/${TASK}/series`, "POST", change, crossSite),
          params("taskId", TASK),
        ),
    ],
    [
      "delete series",
      () =>
        removeSeries(
          request(
            `/tasks/${TASK}/series/delete`,
            "POST",
            { scope: "series", expectedSeriesRevision: 1, dryRun: false },
            crossSite,
          ),
          params("taskId", TASK),
        ),
    ],
    [
      "pause series",
      () =>
        pauseSeries(
          request(
            `/tasks/${TASK}/series/paused`,
            "PUT",
            { paused: true, expectedSeriesRevision: 1 },
            crossSite,
          ),
          params("taskId", TASK),
        ),
    ],
  ];

  it.each(calls)("refuses a cross-site %s (CSRF)", async (_name, call) => {
    expect((await call()).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 401 without a verified identity", async () => {
    state.identity = null;
    expect(
      (await changeSeries(request(`/tasks/${TASK}/series`, "POST", change), params("taskId", TASK)))
        .status,
    ).toBe(401);
    expect(
      (await occurrences(request(`/tasks/${TASK}/occurrences`, "GET"), params("taskId", TASK)))
        .status,
    ).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/tasks with a recurrence", () => {
  it("creates a series: sorted weekdays, the start date as an offset, the first occurrence back", async () => {
    answers({ create_task_series: [{ outcome: "created", first_task_id: TASK, revision: 1 }] });
    const response = await createTask(request("/tasks", "POST", newSeries));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: SERIES, taskId: TASK, revision: 1 });
    expect(state.rpc).toHaveBeenCalledWith("create_task_series", {
      p_id: SERIES,
      p_list_id: LIST,
      p_title: "Water the plants",
      p_frequency: "weekly",
      p_interval: 2,
      p_starts_on: "2026-10-19",
      p_weekdays: [1, 4],
      p_max_count: 10,
      p_start_offset: 2,
      p_label_ids: [],
      p_assignee_ids: [MEMBER],
      p_home_id: HOME,
      p_today: today,
    });
  });

  it.each([
    [{ ...newSeries, dueDate: "2026-10-20" }, "dueDate"],
    [{ ...newSeries, dueDate: null }, "dueDate"],
    [{ ...newSeries, recurrence: { ...weekly, weekdays: null } }, "recurrence"],
    [{ ...newSeries, recurrence: { ...weekly, frequency: "daily" } }, "recurrence"],
    [{ ...newSeries, recurrence: { ...weekly, interval: 100 } }, "recurrence"],
    [{ ...newSeries, recurrence: { ...weekly, count: 1000 } }, "recurrence"],
    [{ ...newSeries, recurrence: { ...weekly, endsOn: "2026-10-18" } }, "recurrence"],
    [{ ...newSeries, startDate: "2025-10-18" }, "startDate"],
    [{ ...newSeries, recurrence: { ...weekly, extra: 1 } }, "recurrence"],
  ])("refuses an invalid schedule %#", async (body, field) => {
    const response = await createTask(request("/tasks", "POST", body));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { fields: string[] };
    expect(payload.fields.some((name) => name.startsWith(field))).toBe(true);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps a refused series like a refused task", async () => {
    answers({
      create_task_series: [{ outcome: "limit_reached", first_task_id: null, revision: null }],
    });
    const response = await createTask(request("/tasks", "POST", newSeries));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "limit-reached" });
  });
});

describe("POST /api/v1/tasks/:id/series", () => {
  it("previews a change with the same arguments as the change itself", async () => {
    answers({
      update_task_series: [{ outcome: "preview", impact, revision: 4, task_id: TASK }],
    });
    const response = await changeSeries(
      request(`/tasks/${TASK}/series`, "POST", change),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "preview",
      impact,
      revision: 4,
      taskId: TASK,
    });
    expect(state.rpc).toHaveBeenCalledWith("update_task_series", {
      p_task_id: TASK,
      p_scope: "following",
      p_expected_task_revision: 2,
      p_expected_series_revision: 4,
      p_dry_run: true,
      p_set_content: true,
      p_title: "Water all the plants",
      p_priority: "high",
      p_label_ids: [],
      p_start_offset: 1,
      p_copy_subtasks: true,
      p_today: today,
    });
  });

  it("sends a schedule and assignees without touching the content", async () => {
    answers({
      update_task_series: [{ outcome: "saved", impact, revision: 5, task_id: null }],
    });
    const response = await changeSeries(
      request(`/tasks/${TASK}/series`, "POST", {
        scope: "series",
        expectedTaskRevision: 2,
        expectedSeriesRevision: 4,
        dryRun: false,
        assigneeIds: [],
        schedule: {
          ...weekly,
          frequency: "monthly",
          weekdays: null,
          count: null,
          endsOn: "2027-01-01",
        },
      }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { taskId: unknown }).taskId).toBeNull();
    expect(state.rpc).toHaveBeenCalledWith("update_task_series", {
      p_task_id: TASK,
      p_scope: "series",
      p_expected_task_revision: 2,
      p_expected_series_revision: 4,
      p_dry_run: false,
      p_assignee_ids: [],
      p_set_schedule: true,
      p_frequency: "monthly",
      p_interval: 2,
      p_starts_on: "2026-10-19",
      p_ends_on: "2027-01-01",
      p_today: today,
    });
  });

  it.each([
    [{ ...change, scope: "this" }, "scope"],
    [{ ...change, content: undefined }, "content"],
    [{ ...change, dryRun: undefined }, "dryRun"],
    [{ ...change, content: { ...change.content, startOffset: 366 } }, "content"],
  ])("refuses an invalid change %#", async (body, field) => {
    const response = await changeSeries(
      request(`/tasks/${TASK}/series`, "POST", body),
      params("taskId", TASK),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { fields: string[] };
    expect(payload.fields.some((name) => name.startsWith(field))).toBe(true);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["conflict", 409, { error: "conflict", revision: 6 }],
    ["scope_unavailable", 409, { error: "scope-unavailable" }],
    ["not_recurring", 409, { error: "not-recurring" }],
    ["ended", 409, { error: "schedule-ended" }],
    ["not_permitted", 403, { error: "not-permitted" }],
    ["not_found", 404, { error: "not-found" }],
  ])("maps %s to %i", async (outcome, status, body) => {
    answers({ update_task_series: [{ outcome, impact: null, revision: 6, task_id: null }] });
    const response = await changeSeries(
      request(`/tasks/${TASK}/series`, "POST", change),
      params("taskId", TASK),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it("answers 404 for a malformed task id", async () => {
    const response = await changeSeries(
      request(`/tasks/x/series`, "POST", change),
      params("taskId", "x"),
    );
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/tasks/:id/series/delete", () => {
  it("previews, then moves the occurrences to the trash as one entry", async () => {
    const removal = { scope: "following", removed: 4, completed: 2 };
    answers({ delete_task_series: [{ outcome: "preview", impact: removal, entry_id: null }] });
    let response = await removeSeries(
      request(`/tasks/${TASK}/series/delete`, "POST", {
        scope: "following",
        expectedSeriesRevision: 3,
        dryRun: true,
      }),
      params("taskId", TASK),
    );
    expect(await response.json()).toEqual({
      outcome: "preview",
      impact: removal,
      trashEntryId: null,
    });
    expect(state.rpc).toHaveBeenCalledWith("delete_task_series", {
      p_task_id: TASK,
      p_scope: "following",
      p_expected_series_revision: 3,
      p_dry_run: true,
    });
    answers({ delete_task_series: [{ outcome: "deleted", impact: removal, entry_id: ENTRY }] });
    response = await removeSeries(
      request(`/tasks/${TASK}/series/delete`, "POST", {
        scope: "following",
        expectedSeriesRevision: 3,
        dryRun: false,
      }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { trashEntryId: string }).trashEntryId).toBe(ENTRY);
  });

  it("refuses the scope of one occurrence (that is DELETE /tasks/:id)", async () => {
    const response = await removeSeries(
      request(`/tasks/${TASK}/series/delete`, "POST", {
        scope: "this",
        expectedSeriesRevision: 3,
        dryRun: false,
      }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(400);
  });

  it("answers a stale series revision with conflict", async () => {
    answers({ delete_task_series: [{ outcome: "conflict", impact: null, entry_id: null }] });
    const response = await removeSeries(
      request(`/tasks/${TASK}/series/delete`, "POST", {
        scope: "series",
        expectedSeriesRevision: 1,
        dryRun: false,
      }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(409);
  });
});

describe("PUT /api/v1/tasks/:id/series/paused", () => {
  it("pauses with the expected revision and answers the new one", async () => {
    answers({ set_task_series_paused: [{ outcome: "saved", revision: 8 }] });
    const response = await pauseSeries(
      request(`/tasks/${TASK}/series/paused`, "PUT", { paused: true, expectedSeriesRevision: 7 }),
      params("taskId", TASK),
    );
    expect(await response.json()).toEqual({ revision: 8 });
    expect(state.rpc).toHaveBeenCalledWith("set_task_series_paused", {
      p_task_id: TASK,
      p_paused: true,
      p_expected_series_revision: 7,
      p_today: today,
    });
  });

  it("maps a one-off task to not-recurring", async () => {
    answers({ set_task_series_paused: [{ outcome: "not_recurring", revision: null }] });
    const response = await pauseSeries(
      request(`/tasks/${TASK}/series/paused`, "PUT", { paused: false, expectedSeriesRevision: 1 }),
      params("taskId", TASK),
    );
    expect(await response.json()).toEqual({ error: "not-recurring" });
  });
});

describe("GET /api/v1/tasks/:id/occurrences", () => {
  it("reads a page of the history in the person's timezone", async () => {
    answers({
      list_task_occurrences: [
        {
          id: TASK,
          occurrence_date: "2026-10-12",
          due_date: "2026-10-12",
          status: "completed_late",
          completed_at: "2026-10-13T08:00:00Z",
          completed_by_me: false,
          completed_by_member: MEMBER,
          is_current: true,
          total_count: 51,
        },
      ],
    });
    const response = await occurrences(
      request(`/tasks/${TASK}/occurrences?filter=completed&offset=50`, "GET"),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      filter: "completed",
      total: 51,
      occurrences: [
        {
          id: TASK,
          occurrenceDate: "2026-10-12",
          dueDate: "2026-10-12",
          status: "completed_late",
          completedAt: "2026-10-13T08:00:00Z",
          completedBy: { me: false, member: MEMBER },
          current: true,
        },
      ],
    });
    expect(state.rpc).toHaveBeenCalledWith("list_task_occurrences", {
      p_task_id: TASK,
      p_filter: "completed",
      p_offset: 50,
      p_limit: 50,
      p_today: today,
      p_time_zone: "Europe/Brussels",
    });
  });

  it("defaults to every occurrence from the start; an open one has no completer", async () => {
    answers({
      list_task_occurrences: [
        {
          id: TASK,
          occurrence_date: "2026-10-12",
          due_date: "2026-10-12",
          status: "missed",
          completed_at: null,
          completed_by_me: false,
          completed_by_member: null,
          is_current: false,
          total_count: 1,
        },
      ],
    });
    const response = await occurrences(
      request(`/tasks/${TASK}/occurrences`, "GET"),
      params("taskId", TASK),
    );
    const page = (await response.json()) as { occurrences: { completedBy: unknown }[] };
    expect(page.occurrences[0]?.completedBy).toBeNull();
    expect(state.rpc).toHaveBeenCalledWith(
      "list_task_occurrences",
      expect.objectContaining({ p_filter: "all", p_offset: 0 }),
    );
  });

  it.each(["filter=late", "offset=-1", "offset=x"])("refuses %s", async (query) => {
    const response = await occurrences(
      request(`/tasks/${TASK}/occurrences?${query}`, "GET"),
      params("taskId", TASK),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a failed read with 500, not with an empty history", async () => {
    answers({});
    const response = await occurrences(
      request(`/tasks/${TASK}/occurrences`, "GET"),
      params("taskId", TASK),
    );
    expect(response.status).toBe(500);
  });
});

describe("lists used by a series", () => {
  it("refuses deleting a list a series still uses, with the count", async () => {
    answers({ delete_task_list: [{ outcome: "has_series", entry_id: null, active_tasks: 1 }] });
    const response = await deleteList(
      request(`/task-lists/${LIST}`, "DELETE", { expectedRevision: 1 }),
      params("listId", LIST),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "has-series", count: 1 });
  });
});
