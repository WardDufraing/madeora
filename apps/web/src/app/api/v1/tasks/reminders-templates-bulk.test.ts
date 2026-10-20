// S19b: the reminder, template and bulk routes. The database decides times, rights, scopes and
// per-task outcomes (tests/db/rls/task-reminders.test.sql, task-templates-bulk.test.sql); these
// tests check what the routes send it and how they answer.
import type { Mock } from "vitest";

import {
  DELETE as deleteTemplate,
  PATCH as updateTemplate,
} from "../task-templates/[templateId]/route";
import { POST as createFromTemplate } from "../task-templates/[templateId]/tasks/route";
import { GET as listTemplates, POST as createTemplate } from "../task-templates/route";
import { POST as reviewReminder } from "./[taskId]/reminder/review/route";
import {
  DELETE as removeReminder,
  GET as readReminder,
  PUT as setReminder,
} from "./[taskId]/reminder/route";
import { POST as bulk } from "./bulk/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const TASK_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const TEMPLATE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
const LABEL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";

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

const relative = {
  scope: "this",
  mode: "relative",
  daysBefore: 1,
  time: "09:00",
  expectedRevision: 0,
  expectedSeriesRevision: null,
  dryRun: false,
};
const template = {
  name: "Bins",
  title: "Take out the bins",
  description: null,
  priority: "normal",
  labelIds: [LABEL],
  subtasks: ["Paper", "Glass"],
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("every S19b mutation", () => {
  const calls: readonly [string, () => Promise<Response>][] = [
    [
      "set reminder",
      () =>
        setReminder(
          request(`/tasks/${TASK}/reminder`, "PUT", relative, crossSite),
          params("taskId", TASK),
        ),
    ],
    [
      "remove reminder",
      () =>
        removeReminder(
          request(`/tasks/${TASK}/reminder`, "DELETE", { ...relative }, crossSite),
          params("taskId", TASK),
        ),
    ],
    [
      "review reminder",
      () =>
        reviewReminder(
          request(
            `/tasks/${TASK}/reminder/review`,
            "POST",
            { choice: "follow", expectedRevision: 2 },
            crossSite,
          ),
          params("taskId", TASK),
        ),
    ],
    [
      "create template",
      () =>
        createTemplate(
          request(
            "/task-templates",
            "POST",
            { id: TEMPLATE, homeId: HOME, ...template },
            crossSite,
          ),
        ),
    ],
    [
      "bulk",
      () =>
        bulk(
          request(
            "/tasks/bulk",
            "POST",
            {
              homeId: HOME,
              taskIds: [TASK],
              action: "complete",
              expectedRevisions: null,
              dryRun: true,
            },
            crossSite,
          ),
        ),
    ],
  ];

  it.each(calls)(
    "%s refuses a cross-site request before touching the database",
    async (_name, call) => {
      const response = await call();
      expect(response.status).toBe(403);
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("refuses without a verified identity", async () => {
    state.identity = null;
    const response = await setReminder(
      request(`/tasks/${TASK}/reminder`, "PUT", relative),
      params("taskId", TASK),
    );
    expect(response.status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(
      (await readReminder(request(`/tasks/${TASK}/reminder`, "GET"), params("taskId", TASK)))
        .status,
    ).toBe(401);
  });
});

describe("reminders", () => {
  it("sends a relative reminder with the person's own zone, never one from the request", async () => {
    answers({
      set_task_reminder: [
        {
          outcome: "saved",
          fire_at: "2027-03-27T08:00:00+00:00",
          dst: null,
          impact: null,
          revision: 1,
        },
      ],
    });
    const response = await setReminder(
      request(`/tasks/${TASK}/reminder`, "PUT", relative),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "saved",
      fireAt: "2027-03-27T08:00:00+00:00",
      dst: null,
      impact: null,
      revision: 1,
    });
    expect(state.rpc).toHaveBeenCalledWith("set_task_reminder", {
      p_task_id: TASK,
      p_scope: "this",
      p_mode: "relative",
      p_expected_revision: 0,
      p_days_before: 1,
      p_time: "09:00",
      p_time_zone: "Europe/Brussels",
      p_dry_run: false,
    });
  });

  it("refuses a zone in the body", async () => {
    const response = await setReminder(
      request(`/tasks/${TASK}/reminder`, "PUT", { ...relative, timeZone: "Asia/Tokyo" }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("sends a wall-clock time for an absolute reminder and previews with the series revision", async () => {
    answers({
      set_task_reminder: [
        {
          outcome: "preview",
          fire_at: "2027-03-28T01:30:00+00:00",
          dst: "gap",
          impact: null,
          revision: 0,
        },
      ],
    });
    const response = await setReminder(
      request(`/tasks/${TASK}/reminder`, "PUT", {
        scope: "this",
        mode: "absolute",
        localAt: "2027-03-28T02:30",
        expectedRevision: 0,
        expectedSeriesRevision: null,
        dryRun: true,
      }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "preview", dst: "gap" });
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_local_at: "2027-03-28T02:30:00",
      p_dry_run: true,
    });
  });

  it.each([
    [{ ...relative, scope: "series" }, "series scope without the series revision"],
    [
      {
        ...relative,
        scope: "following",
        mode: "absolute",
        localAt: "2027-01-01T09:00",
        expectedSeriesRevision: 1,
      },
      "absolute for following",
    ],
    [{ ...relative, daysBefore: 31 }, "more than 30 days"],
    [{ ...relative, time: "24:00" }, "an invalid time"],
    [
      {
        scope: "this",
        mode: "absolute",
        localAt: "2027-02-30T09:00",
        expectedRevision: 0,
        expectedSeriesRevision: null,
        dryRun: false,
      },
      "a date that does not exist",
    ],
  ])("refuses %s", async (body, _why) => {
    const response = await setReminder(
      request(`/tasks/${TASK}/reminder`, "PUT", body),
      params("taskId", TASK),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["in_past", 409, "in-past"],
    ["needs_due_date", 409, "needs-due-date"],
    ["task_completed", 409, "task-completed"],
    ["conflict", 409, "conflict"],
    ["not_permitted", 403, "not-permitted"],
    ["not_found", 404, "not-found"],
    ["not_recurring", 409, "not-recurring"],
  ])("answers %s as %i %s", async (outcome, status, error) => {
    answers({
      set_task_reminder: [{ outcome, fire_at: null, dst: null, impact: null, revision: 3 }],
    });
    const response = await setReminder(
      request(`/tasks/${TASK}/reminder`, "PUT", relative),
      params("taskId", TASK),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
  });

  it("removes for the entire series with both revisions", async () => {
    const impact = { scope: "series", updated: 3, kept: 1, past: 0, completed: 2 };
    answers({ remove_task_reminder: [{ outcome: "deleted", impact, revision: 5 }] });
    const response = await removeReminder(
      request(`/tasks/${TASK}/reminder`, "DELETE", {
        scope: "series",
        expectedRevision: 2,
        expectedSeriesRevision: 4,
        dryRun: false,
      }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "deleted", impact, revision: 5 });
    expect(state.rpc).toHaveBeenCalledWith("remove_task_reminder", {
      p_task_id: TASK,
      p_scope: "series",
      p_expected_revision: 2,
      p_expected_series_revision: 4,
      p_dry_run: false,
    });
  });

  it("settles a reminder on hold, and says when it no longer is", async () => {
    answers({
      review_task_reminder: [
        { outcome: "saved", fire_at: "2027-04-01T07:00:00+00:00", revision: 3 },
      ],
    });
    const ok = await reviewReminder(
      request(`/tasks/${TASK}/reminder/review`, "POST", { choice: "follow", expectedRevision: 2 }),
      params("taskId", TASK),
    );
    expect(ok.status).toBe(200);
    answers({ review_task_reminder: [{ outcome: "not_needed", fire_at: null, revision: 3 }] });
    const settled = await reviewReminder(
      request(`/tasks/${TASK}/reminder/review`, "POST", { choice: "remove", expectedRevision: 2 }),
      params("taskId", TASK),
    );
    expect(settled.status).toBe(409);
    expect(await settled.json()).toEqual({ error: "not-needed", revision: 3 });
  });

  it("reads the editor's view, and hides a task the person cannot see", async () => {
    const view = {
      taskId: TASK,
      dueDate: "2027-03-28",
      completed: false,
      recurring: false,
      canEdit: true,
      canEditSeries: false,
      timeZone: "Europe/Brussels",
      reminder: null,
      seriesReminder: null,
      recipients: [],
      recipientsAreAssignees: false,
      channels: { inApp: true, email: false },
    };
    answers({ get_task_reminder: view });
    const response = await readReminder(
      request(`/tasks/${TASK}/reminder`, "GET"),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
    expect(state.rpc).toHaveBeenCalledWith("get_task_reminder", {
      p_task_id: TASK,
      p_time_zone: "Europe/Brussels",
    });
    answers({ get_task_reminder: null });
    const hidden = await readReminder(
      request(`/tasks/${TASK}/reminder`, "GET"),
      params("taskId", TASK),
    );
    expect(hidden.status).toBe(404);
  });

  it("reads a reminder on hold and one switched off, which have no time", async () => {
    const base = {
      taskId: TASK,
      dueDate: "2027-04-02",
      completed: false,
      recurring: true,
      canEdit: true,
      canEditSeries: true,
      timeZone: "Europe/Brussels",
      seriesReminder: null,
      recipients: null,
      recipientsAreAssignees: false,
      channels: { inApp: true, email: false },
    };
    // The shapes get_task_reminder returns for these states (task_reminders_shape_check).
    const onHold = {
      mode: "relative",
      localAt: null,
      daysBefore: 1,
      time: "09:00",
      timeZone: "Europe/Brussels",
      fireAt: null,
      dst: null,
      status: "needs_review",
      own: true,
      revision: 3,
      reviewFireAt: "2027-04-01T07:00:00+00:00",
      reviewDst: null,
    };
    const off = {
      mode: null,
      localAt: null,
      daysBefore: null,
      time: null,
      timeZone: null,
      fireAt: null,
      dst: null,
      status: "off",
      own: true,
      revision: 2,
      reviewFireAt: null,
      reviewDst: null,
    };
    for (const reminder of [onHold, off]) {
      answers({ get_task_reminder: { ...base, reminder } });
      const response = await readReminder(
        request(`/tasks/${TASK}/reminder`, "GET"),
        params("taskId", TASK),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...base, reminder });
    }
  });
});

describe("templates", () => {
  it("creates one with a client id, and answers a retry with the same template", async () => {
    answers({ create_task_template: [{ outcome: "created", revision: 1 }] });
    const created = await createTemplate(
      request("/task-templates", "POST", {
        id: TEMPLATE,
        homeId: HOME,
        ...template,
        title: " Take out the bins ",
      }),
    );
    expect(created.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_task_template", {
      p_id: TEMPLATE,
      p_name: "Bins",
      p_title: "Take out the bins",
      p_priority: "normal",
      p_label_ids: [LABEL],
      p_subtasks: ["Paper", "Glass"],
      p_home_id: HOME,
    });
    answers({ create_task_template: [{ outcome: "exists", revision: 1 }] });
    const retried = await createTemplate(
      request("/task-templates", "POST", { id: TEMPLATE, homeId: HOME, ...template }),
    );
    expect(retried.status).toBe(200);
  });

  it.each([
    [{ ...template, name: "" }, "an empty name"],
    [{ ...template, name: "x".repeat(61) }, "a name over 60 characters"],
    [{ ...template, subtasks: Array.from({ length: 101 }, () => "Item") }, "more than 100 items"],
    [{ ...template, dueDate: "2027-01-01" }, "a date"],
    [{ ...template, assigneeIds: [] }, "people"],
  ])("refuses %s", async (body, _why) => {
    const response = await createTemplate(
      request("/task-templates", "POST", { id: TEMPLATE, homeId: HOME, ...body }),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate_name", 409, "duplicate-name"],
    ["limit_reached", 409, "limit-reached"],
    ["not_permitted", 403, "not-permitted"],
    ["invalid_label", 400, "invalid"],
  ])("answers %s as %i %s", async (outcome, status, error) => {
    answers({ create_task_template: [{ outcome, revision: null }] });
    const response = await createTemplate(
      request("/task-templates", "POST", { id: TEMPLATE, homeId: HOME, ...template }),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
  });

  it("lists, saves and deletes with revisions", async () => {
    answers({
      list_task_templates: [
        {
          id: TEMPLATE,
          name: "Bins",
          title: "Take out the bins",
          priority: "odd",
          label_count: 1,
          subtask_count: 2,
          revision: 3,
        },
      ],
      update_task_template: [{ outcome: "conflict", revision: 4 }],
      delete_task_template: [{ outcome: "deleted", revision: null }],
    });
    const list = await listTemplates(request(`/task-templates?homeId=${HOME}`, "GET"));
    expect(await list.json()).toEqual({
      templates: [
        {
          id: TEMPLATE,
          name: "Bins",
          title: "Take out the bins",
          priority: null,
          labelCount: 1,
          subtaskCount: 2,
          revision: 3,
        },
      ],
    });
    const save = await updateTemplate(
      request(`/task-templates/${TEMPLATE}`, "PATCH", { expectedRevision: 3, ...template }),
      params("templateId", TEMPLATE),
    );
    expect(save.status).toBe(409);
    expect(await save.json()).toEqual({ error: "conflict", revision: 4 });
    const removed = await deleteTemplate(
      request(`/task-templates/${TEMPLATE}`, "DELETE", { expectedRevision: 3 }),
      params("templateId", TEMPLATE),
    );
    expect(removed.status).toBe(200);
  });

  it("creates a task from a reviewed preview, and says when the template changed", async () => {
    const body = {
      taskId: TASK,
      expectedTemplateRevision: 3,
      listId: LIST,
      title: "Take out the bins",
      description: null,
      priority: null,
      labelIds: [],
      subtasks: ["Paper"],
      startDate: null,
      dueDate: "2027-01-05",
    };
    answers({ create_task_from_template: [{ outcome: "created", revision: 1 }] });
    const created = await createFromTemplate(
      request(`/task-templates/${TEMPLATE}/tasks`, "POST", body),
      params("templateId", TEMPLATE),
    );
    expect(created.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_task_from_template", {
      p_task_id: TASK,
      p_template_id: TEMPLATE,
      p_expected_template_revision: 3,
      p_list_id: LIST,
      p_title: "Take out the bins",
      p_label_ids: [],
      p_subtasks: ["Paper"],
      p_due_date: "2027-01-05",
    });
    answers({ create_task_from_template: [{ outcome: "template_changed", revision: 4 }] });
    const stale = await createFromTemplate(
      request(`/task-templates/${TEMPLATE}/tasks`, "POST", body),
      params("templateId", TEMPLATE),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "template-changed", revision: 4 });
  });
});

describe("bulk actions", () => {
  it("previews without revisions and answers each task's result", async () => {
    answers({
      bulk_update_tasks: [
        {
          task_id: TASK,
          outcome: "will_change",
          revision: 2,
          open_subtasks: 1,
          recurring: false,
          shared: true,
        },
        {
          task_id: TASK_B,
          outcome: "not_found",
          revision: null,
          open_subtasks: null,
          recurring: null,
          shared: null,
        },
      ],
    });
    const response = await bulk(
      request("/tasks/bulk", "POST", {
        homeId: HOME,
        taskIds: [TASK, TASK_B],
        action: "complete",
        expectedRevisions: null,
        dryRun: true,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "complete",
      dryRun: true,
      results: [
        {
          taskId: TASK,
          outcome: "will_change",
          revision: 2,
          openSubtasks: 1,
          recurring: false,
          shared: true,
        },
        {
          taskId: TASK_B,
          outcome: "not_found",
          revision: null,
          openSubtasks: null,
          recurring: null,
          shared: null,
        },
      ],
    });
    expect(state.rpc).toHaveBeenCalledWith("bulk_update_tasks", {
      p_task_ids: [TASK, TASK_B],
      p_action: "complete",
      p_expected_revisions: {},
      p_dry_run: true,
      p_home_id: HOME,
    });
  });

  it("sends each action's value", async () => {
    answers({ bulk_update_tasks: [] });
    const base = { homeId: null, taskIds: [TASK], expectedRevisions: { [TASK]: 2 }, dryRun: false };
    await bulk(
      request("/tasks/bulk", "POST", {
        ...base,
        action: "labels",
        labelMode: "remove",
        labelIds: [LABEL],
      }),
    );
    await bulk(request("/tasks/bulk", "POST", { ...base, action: "move", listId: LIST }));
    await bulk(request("/tasks/bulk", "POST", { ...base, action: "priority", priority: null }));
    expect(state.rpc.mock.calls.map((call) => call[1])).toEqual([
      {
        p_task_ids: [TASK],
        p_action: "labels",
        p_expected_revisions: { [TASK]: 2 },
        p_dry_run: false,
        p_label_mode: "remove",
        p_label_ids: [LABEL],
      },
      {
        p_task_ids: [TASK],
        p_action: "move",
        p_expected_revisions: { [TASK]: 2 },
        p_dry_run: false,
        p_list_id: LIST,
      },
      {
        p_task_ids: [TASK],
        p_action: "priority",
        p_expected_revisions: { [TASK]: 2 },
        p_dry_run: false,
      },
    ]);
  });

  it("reports an outcome it does not know as failed", async () => {
    answers({
      bulk_update_tasks: [
        {
          task_id: TASK,
          outcome: "exploded",
          revision: 1,
          open_subtasks: 0,
          recurring: false,
          shared: false,
        },
      ],
    });
    const response = await bulk(
      request("/tasks/bulk", "POST", {
        homeId: null,
        taskIds: [TASK],
        action: "complete",
        expectedRevisions: { [TASK]: 1 },
        dryRun: false,
      }),
    );
    expect(await response.json()).toMatchObject({ results: [{ taskId: TASK, outcome: "failed" }] });
  });

  it.each([
    [
      { homeId: null, taskIds: [TASK], action: "complete", expectedRevisions: null, dryRun: false },
      "applying without revisions",
    ],
    [
      { homeId: null, taskIds: [], action: "complete", expectedRevisions: null, dryRun: true },
      "no tasks",
    ],
    [
      {
        homeId: null,
        taskIds: Array.from({ length: 101 }, () => TASK),
        action: "complete",
        expectedRevisions: null,
        dryRun: true,
      },
      "more than 100 tasks",
    ],
    [
      { homeId: null, taskIds: [TASK], action: "assign", expectedRevisions: null, dryRun: true },
      "an action the spec excludes",
    ],
    [
      {
        homeId: null,
        taskIds: [TASK],
        action: "labels",
        labelMode: "toggle",
        labelIds: [],
        expectedRevisions: null,
        dryRun: true,
      },
      "an unknown label mode",
    ],
  ])("refuses %s", async (body, _why) => {
    const response = await bulk(request("/tasks/bulk", "POST", body));
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps a database refusal of the context to not found", async () => {
    state.rpc.mockImplementation(() => ({
      data: null,
      error: { code: "42501", message: "not permitted" },
    }));
    const response = await bulk(
      request("/tasks/bulk", "POST", {
        homeId: HOME,
        taskIds: [TASK],
        action: "complete",
        expectedRevisions: null,
        dryRun: true,
      }),
    );
    expect(response.status).toBe(404);
  });
});
