import type { Mock } from "vitest";

import { PATCH as patchComment } from "../task-comments/[commentId]/route";
import { DELETE as deleteLabel, PATCH as patchLabel } from "../task-labels/[labelId]/route";
import { POST as createLabel } from "../task-labels/route";
import { DELETE as deleteList, PATCH as patchList } from "../task-lists/[listId]/route";
import { POST as createList, PUT as orderLists } from "../task-lists/route";
import { PATCH as patchSubtask } from "../subtasks/[subtaskId]/route";
import { PUT as assign } from "./[taskId]/assignees/route";
import { GET as getComments, POST as addComment } from "./[taskId]/comments/route";
import { PUT as complete } from "./[taskId]/completion/route";
import { PUT as move } from "./[taskId]/list/route";
import { DELETE as deleteTask, PATCH as patchTask } from "./[taskId]/route";
import { POST as addSubtask } from "./[taskId]/subtasks/route";
import { GET as listTasks, POST as createTask } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";

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

const newTask = {
  id: TASK,
  homeId: HOME,
  listId: LIST,
  title: "  Fix the tap ",
  description: "",
  startDate: null,
  dueDate: "2026-10-20",
  priority: "high",
  labelIds: [],
  assigneeIds: [MEMBER],
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("every task mutation", () => {
  const calls: readonly [string, () => Promise<Response>][] = [
    [
      "create task",
      () =>
        createTask(
          request("/tasks", "POST", newTask, {
            origin: "https://evil.example",
            host: "madeora.example",
          }),
        ),
    ],
    [
      "complete",
      () =>
        complete(
          request(
            `/tasks/${TASK}/completion`,
            "PUT",
            { completed: true },
            { origin: "https://evil.example", host: "madeora.example" },
          ),
          params("taskId", TASK),
        ),
    ],
    [
      "create list",
      () =>
        createList(
          request(
            "/task-lists",
            "POST",
            { id: LIST, homeId: null, name: "A" },
            { origin: "https://evil.example", host: "madeora.example" },
          ),
        ),
    ],
  ];

  it.each(calls)("refuses a cross-site %s (CSRF)", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const response = await createTask(
      new Request("https://madeora.example/api/v1/tasks", {
        method: "POST",
        headers: { "content-type": "text/plain", ...sameOrigin },
        body: "title=x",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("answers 401 without a verified identity", async () => {
    state.identity = null;
    expect((await createTask(request("/tasks", "POST", newTask))).status).toBe(401);
    expect((await listTasks(request("/tasks", "GET"))).status).toBe(401);
    expect(
      (await getComments(request(`/tasks/${TASK}/comments`, "GET"), params("taskId", TASK))).status,
    ).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/tasks", () => {
  it("creates with the normalized title, leaving out empty optional fields", async () => {
    answers({ create_task: [{ outcome: "created", revision: 1 }] });
    const response = await createTask(request("/tasks", "POST", newTask));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: TASK, revision: 1 });
    expect(state.rpc).toHaveBeenCalledWith("create_task", {
      p_id: TASK,
      p_list_id: LIST,
      p_title: "Fix the tap",
      p_due_date: "2026-10-20",
      p_priority: "high",
      p_label_ids: [],
      p_assignee_ids: [MEMBER],
      p_home_id: HOME,
    });
  });

  it("answers a retry with the same task (200)", async () => {
    answers({ create_task: [{ outcome: "exists", revision: 3 }] });
    expect((await createTask(request("/tasks", "POST", newTask))).status).toBe(200);
  });

  it.each([
    [{ ...newTask, title: "   " }, "title"],
    [{ ...newTask, startDate: "2026-10-21", dueDate: "2026-10-20" }, "dueDate"],
    [{ ...newTask, dueDate: "2026-02-30" }, "dueDate"],
    [{ ...newTask, priority: "critical" }, "priority"],
    [{ ...newTask, homeId: null }, "assigneeIds"],
    [{ ...newTask, extra: true }, ""],
  ])("refuses invalid input %#", async (body, field) => {
    const response = await createTask(request("/tasks", "POST", body));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; fields: string[] };
    expect(payload.error).toBe("invalid");
    if (field) expect(payload.fields).toContain(field);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["not_permitted", 403, "not-permitted"],
    ["list_unavailable", 409, "list-unavailable"],
    ["id_taken", 409, "id-taken"],
    ["invalid_assignee", 400, "invalid"],
    ["invalid_label", 400, "invalid"],
  ])("maps %s to %i", async (outcome, status, error) => {
    answers({ create_task: [{ outcome, revision: null }] });
    const response = await createTask(request("/tasks", "POST", newTask));
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: string }).error).toBe(error);
  });

  it("answers a Home the person is not in like one that does not exist", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await createTask(request("/tasks", "POST", newTask))).status).toBe(404);
  });

  it("answers an unconfirmed session 401", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not signed in" } });
    expect((await createTask(request("/tasks", "POST", newTask))).status).toBe(401);
  });

  it("hides database failures behind 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.rpc.mockReturnValue({ data: null, error: { code: "XX000", message: "Paint the hall" } });
    const response = await createTask(request("/tasks", "POST", newTask));
    expect(response.status).toBe(500);
    // Logged by event and code only: never the title or an id.
    expect(log.mock.calls.flat().join(" ")).not.toContain("Fix the tap");
    expect(log.mock.calls.flat().join(" ")).not.toContain(TASK);
    log.mockRestore();
  });
});

describe("GET /api/v1/tasks", () => {
  it("passes the filters and answers small rows with the total", async () => {
    answers({
      list_tasks: [
        {
          id: TASK,
          list_id: LIST,
          list_name: "Renovation",
          title: "Fix the tap",
          start_date: null,
          due_date: "2026-10-20",
          priority: null,
          completed_at: null,
          needs_reassignment: false,
          overdue: false,
          upcoming: false,
          subtasks_done: 1,
          subtasks_total: 2,
          comment_count: 0,
          label_ids: [],
          assignee_member_ids: [MEMBER],
          assigned_to_me: true,
          revision: 2,
          total_count: 51,
        },
      ],
    });
    const response = await listTasks(
      request(
        `/tasks?homeId=${HOME}&list=${LIST}&when=overdue&priority=high&priority=unset&assignee=me&offset=50`,
        "GET",
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; tasks: { title: string }[] };
    expect(body.total).toBe(51);
    expect(body.tasks[0]?.title).toBe("Fix the tap");
    expect(state.rpc).toHaveBeenCalledWith(
      "list_tasks",
      expect.objectContaining({
        p_home_id: HOME,
        p_list_id: LIST,
        p_when: "overdue",
        p_priorities: ["high", "unset"],
        p_assignee: "me",
        p_limit: 50,
        p_offset: 50,
        p_hide_future: true,
      }),
    );
  });

  it("refuses unknown filter values", async () => {
    expect((await listTasks(request("/tasks?when=someday", "GET"))).status).toBe(400);
    expect((await listTasks(request("/tasks?homeId=nope", "GET"))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for a Home the person is not in", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await listTasks(request(`/tasks?homeId=${HOME}`, "GET"))).status).toBe(404);
  });
});

describe("task changes", () => {
  it("answers a stale edit 409 with the current revision", async () => {
    answers({ update_task: [{ outcome: "conflict", revision: 4 }] });
    const response = await patchTask(
      request(`/tasks/${TASK}`, "PATCH", {
        expectedRevision: 2,
        title: "Fix",
        description: null,
        startDate: null,
        dueDate: null,
        priority: null,
        labelIds: [],
      }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", revision: 4 });
  });

  it("answers a malformed task id 404 without calling the database", async () => {
    const response = await complete(
      request("/tasks/nope/completion", "PUT", { completed: true }),
      params("taskId", "nope"),
    );
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("reports the actual completer when someone else completed first", async () => {
    answers({
      set_task_completion: [
        {
          outcome: "already_completed",
          completed_at: "2026-10-16T10:00:00Z",
          completed_by_me: false,
          completed_by_member: MEMBER,
        },
      ],
    });
    const response = await complete(
      request(`/tasks/${TASK}/completion`, "PUT", { completed: true }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "already_completed",
      completedAt: "2026-10-16T10:00:00Z",
      completedBy: { me: false, member: MEMBER },
    });
  });

  it.each([
    ["not_found", 404],
    ["not_permitted", 403],
  ])("maps a completion %s to %i", async (outcome, status) => {
    answers({
      set_task_completion: [
        { outcome, completed_at: null, completed_by_me: false, completed_by_member: null },
      ],
    });
    const response = await complete(
      request(`/tasks/${TASK}/completion`, "PUT", { completed: true }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(status);
  });

  it("refuses assignments from someone without the right", async () => {
    answers({ set_task_assignees: [{ outcome: "not_permitted", revision: null }] });
    const response = await assign(
      request(`/tasks/${TASK}/assignees`, "PUT", { expectedRevision: 1, memberIds: [MEMBER] }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a move into an unusable list", async () => {
    answers({ move_task: [{ outcome: "list_unavailable", revision: null }] });
    const response = await move(
      request(`/tasks/${TASK}/list`, "PUT", { expectedRevision: 1, listId: OTHER }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(409);
  });

  it("moves a task to the trash and returns the entry", async () => {
    answers({ delete_task: [{ outcome: "deleted", entry_id: OTHER }] });
    const response = await deleteTask(
      request(`/tasks/${TASK}`, "DELETE", {}),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ trashEntryId: OTHER });
  });
});

describe("subtasks and comments", () => {
  it("adds a subtask with the client id", async () => {
    answers({ add_subtask: [{ outcome: "created", revision: 1 }] });
    const response = await addSubtask(
      request(`/tasks/${TASK}/subtasks`, "POST", { id: OTHER, title: "Buy a washer" }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("add_subtask", {
      p_id: OTHER,
      p_task_id: TASK,
      p_title: "Buy a washer",
    });
  });

  it("ticks a subtask through the completion function", async () => {
    answers({ set_subtask_completion: [{ outcome: "saved", revision: 2 }] });
    const response = await patchSubtask(
      request(`/subtasks/${OTHER}`, "PATCH", { completed: true }),
      params("subtaskId", OTHER),
    );
    expect(response.status).toBe(200);
  });

  it("refuses a blank comment", async () => {
    const response = await addComment(
      request(`/tasks/${TASK}/comments`, "POST", { id: OTHER, body: " \n " }),
      params("taskId", TASK),
    );
    expect(response.status).toBe(400);
  });

  it("answers someone else's comment 403", async () => {
    answers({ update_task_comment: [{ outcome: "not_permitted", revision: null }] });
    const response = await patchComment(
      request(`/task-comments/${OTHER}`, "PATCH", { expectedRevision: 1, body: "Mine now" }),
      params("commentId", OTHER),
    );
    expect(response.status).toBe(403);
  });

  it("reads comments oldest first, a page at a time", async () => {
    answers({ list_task_comments: [] });
    const response = await getComments(
      request(`/tasks/${TASK}/comments?offset=100`, "GET"),
      params("taskId", TASK),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ comments: [], total: 0 });
    expect(state.rpc).toHaveBeenCalledWith("list_task_comments", {
      p_task_id: TASK,
      p_offset: 100,
      p_limit: 100,
    });
  });
});

describe("lists and labels", () => {
  it("reports a duplicate list name", async () => {
    answers({ create_task_list: [{ outcome: "duplicate_name", revision: null }] });
    const response = await createList(
      request("/task-lists", "POST", { id: LIST, homeId: HOME, name: "Errands" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "duplicate-name" });
  });

  it("reports open tasks in the way of archiving, with their count", async () => {
    answers({ update_task_list: [{ outcome: "has_open_tasks", revision: null, open_tasks: 3 }] });
    const response = await patchList(
      request(`/task-lists/${LIST}`, "PATCH", { expectedRevision: 1, name: "A", archived: true }),
      params("listId", LIST),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "has-open-tasks", count: 3 });
  });

  it("reports active tasks in the way of deleting, with their count", async () => {
    answers({ delete_task_list: [{ outcome: "has_tasks", entry_id: null, active_tasks: 2 }] });
    const response = await deleteList(
      request(`/task-lists/${LIST}`, "DELETE", { expectedRevision: 1 }),
      params("listId", LIST),
    );
    expect(await response.json()).toEqual({ error: "has-tasks", count: 2 });
  });

  it("reorders lists", async () => {
    answers({ reorder_task_lists: "saved" });
    const response = await orderLists(
      request("/task-lists", "PUT", { homeId: null, ids: [LIST, OTHER] }),
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("reorder_task_lists", { p_list_ids: [LIST, OTHER] });
  });

  it("refuses an unknown label colour", async () => {
    const response = await createLabel(
      request("/task-labels", "POST", { id: OTHER, homeId: null, name: "Red", color: "#ff0000" }),
    );
    expect(response.status).toBe(400);
  });

  it("sends a neutral label without a colour", async () => {
    answers({ update_task_label: [{ outcome: "saved", revision: 2 }] });
    await patchLabel(
      request(`/task-labels/${OTHER}`, "PATCH", { expectedRevision: 1, name: "Soon", color: null }),
      params("labelId", OTHER),
    );
    expect(state.rpc).toHaveBeenCalledWith("update_task_label", {
      p_label_id: OTHER,
      p_expected_revision: 1,
      p_name: "Soon",
    });
  });

  it("reports how many tasks a removed label left", async () => {
    answers({ delete_task_label: [{ outcome: "deleted", detached: 4 }] });
    const response = await deleteLabel(
      request(`/task-labels/${OTHER}`, "DELETE", { expectedRevision: 2 }),
      params("labelId", OTHER),
    );
    expect(await response.json()).toEqual({ detached: 4 });
  });
});
