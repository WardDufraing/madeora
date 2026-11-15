import { loadTaskEdit, prepareAction, prepareTaskAction, undoAction, undoTaskEdit } from "./server";
import { UNDO_WINDOW_MS } from "./types";

interface State {
  rpc: { fn: string; args: unknown }[];
  rpcResult: {
    data: { outcome: string }[] | null;
    error: { code: string } | null;
  };
  task: unknown;
  list: unknown;
  taskPage: unknown;
  taskLists: unknown;
  shoppingLists: unknown;
  remembered: string | null;
}
const state = vi.hoisted((): State => ({
  rpc: [],
  rpcResult: { data: [{ outcome: "deleted" }], error: null },
  task: { status: "not-found" },
  list: { status: "not-found" },
  taskPage: { status: "ok", value: { tasks: [], total: 0 } },
  taskLists: { status: "ok", value: [] },
  shoppingLists: { status: "ok", value: [] },
  remembered: null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (fn: string, args: unknown) => {
        state.rpc.push({ fn, args });
        return Promise.resolve(state.rpcResult);
      },
    }),
}));
vi.mock("@/ora/memories/server", () => ({
  loadRemembered: (_context: unknown, _action: unknown, destinations: { id: string }[]) =>
    Promise.resolve(destinations.some((d) => d.id === state.remembered) ? state.remembered : null),
}));
vi.mock("@/tasks/data", () => ({
  getTask: () => Promise.resolve(state.task),
  listTaskLists: () => Promise.resolve(state.taskLists),
  listTasks: () => Promise.resolve(state.taskPage),
}));
vi.mock("@/shopping/data", () => ({
  getShoppingList: () => Promise.resolve(state.list),
  listShoppingLists: () => Promise.resolve(state.shoppingLists),
}));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00aa";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00bb";
const personal = { home: null };
const inHome = {
  home: {
    id: HOME,
    membership: { homeId: HOME, role: "member" as const, grantedCapabilities: new Set<never>() },
  },
};
const undoInput = { step: "undo" as const, id: ID, listId: LIST, expectedRevision: 1 };
const fresh = () => new Date().toISOString();

beforeEach(() => {
  state.remembered = null;
  state.rpc = [];
  state.rpcResult = { data: [{ outcome: "deleted" }], error: null };
  state.task = { status: "not-found" };
  state.list = { status: "not-found" };
});

describe("prepareAction", () => {
  it("offers the active task lists only", async () => {
    state.taskLists = {
      status: "ok",
      value: [
        { id: "a", name: "Inbox", archived: false },
        { id: "b", name: "Old", archived: true },
      ],
    };
    const result = await prepareAction(personal, "add-task");
    expect(result).toEqual({
      status: "ok",
      preview: {
        action: "add-task",
        destinations: [{ id: "a", name: "Inbox" }],
        remembered: null,
      },
    });
  });

  it("offers only shopping lists the person may edit, never view-only or check-only ones", async () => {
    state.shoppingLists = {
      status: "ok",
      value: [
        { id: "m", name: "Manage", archived: false, access: "manage" },
        { id: "e", name: "Edit", archived: false, access: "edit" },
        { id: "c", name: "Check", archived: false, access: "check" },
        { id: "v", name: "View", archived: false, access: "view" },
        { id: "x", name: "Gone", archived: true, access: "manage" },
      ],
    };
    const result = await prepareAction(inHome, "add-shopping-item");
    expect(result.status === "ok" && result.preview.destinations.map((d) => d.id)).toEqual([
      "m",
      "e",
    ]);
  });

  it("preselects the remembered list only while it is still on offer", async () => {
    state.taskLists = {
      status: "ok",
      value: [
        { id: "a", name: "Inbox", archived: false },
        { id: "b", name: "Work", archived: false },
      ],
    };
    state.remembered = "b";
    const found = await prepareAction(personal, "add-task");
    expect(found.status === "ok" && found.preview.remembered).toBe("b");
    // The remembered list was archived: it is not offered, so it is not preselected.
    state.taskLists = { status: "ok", value: [{ id: "a", name: "Inbox", archived: false }] };
    const stale = await prepareAction(personal, "add-task");
    expect(stale.status === "ok" && stale.preview.remembered).toBeNull();
  });

  it("reports unavailable when the lists cannot be read", async () => {
    state.taskLists = { status: "unavailable" };
    expect(await prepareAction(personal, "add-task")).toEqual({ status: "unavailable" });
  });
});

describe("undoAction (tasks)", () => {
  const task = (patch: object = {}) => ({
    status: "ok",
    value: { homeId: null, revision: 1, createdAt: fresh(), ...patch },
  });

  it("moves an untouched, recent task to Trash", async () => {
    state.task = task();
    expect(await undoAction(personal, "add-task", undoInput)).toBe("undone");
    expect(state.rpc).toEqual([
      { fn: "ora_undo_task_create", args: { p_task_id: ID, p_expected_revision: 1 } },
    ]);
  });

  it("does nothing when anyone changed it since (never overwrites their edit)", async () => {
    state.task = task({ revision: 2 });
    expect(await undoAction(personal, "add-task", undoInput)).toBe("changed");
    expect(state.rpc).toEqual([]);
  });

  it("reports changed when the locking function finds an edit made after the reads", async () => {
    state.task = task();
    state.rpcResult = { data: [{ outcome: "conflict" }], error: null };
    expect(await undoAction(personal, "add-task", undoInput)).toBe("changed");
  });

  it("does nothing after the window", async () => {
    state.task = task({ createdAt: new Date(Date.now() - UNDO_WINDOW_MS - 1000).toISOString() });
    expect(await undoAction(personal, "add-task", undoInput)).toBe("expired");
    expect(state.rpc).toEqual([]);
  });

  it("will not remove a task of another place than the one Ora is in", async () => {
    state.task = task({ homeId: HOME });
    expect(await undoAction(personal, "add-task", undoInput)).toBe("gone");
    state.task = task({ homeId: null });
    expect(await undoAction(inHome, "add-task", undoInput)).toBe("gone");
    expect(state.rpc).toEqual([]);
  });

  it("answers gone for a task that is already removed (a second Undo)", async () => {
    expect(await undoAction(personal, "add-task", undoInput)).toBe("gone");
    state.task = task();
    state.rpcResult = { data: [{ outcome: "not_found" }], error: null };
    expect(await undoAction(personal, "add-task", undoInput)).toBe("gone");
  });

  it("is not permitted when the database refuses", async () => {
    state.task = task();
    state.rpcResult = { data: null, error: { code: "42501" } };
    expect(await undoAction(personal, "add-task", undoInput)).toBe("not-permitted");
    state.rpcResult = { data: [{ outcome: "not_permitted" }], error: null };
    expect(await undoAction(personal, "add-task", undoInput)).toBe("not-permitted");
  });

  it("reports unavailable on a read or write failure instead of claiming success", async () => {
    state.task = { status: "unavailable" };
    expect(await undoAction(personal, "add-task", undoInput)).toBe("unavailable");
    state.task = task();
    state.rpcResult = { data: null, error: { code: "XX000" } };
    expect(await undoAction(personal, "add-task", undoInput)).toBe("unavailable");
  });
});

describe("undoAction (shopping items)", () => {
  const list = (items: object[]) => ({ status: "ok", value: { items } });
  const item = (patch: object = {}) => ({ id: ID, revision: 1, createdAt: fresh(), ...patch });

  it("moves an untouched, recent item to Trash", async () => {
    state.list = list([item()]);
    expect(await undoAction(personal, "add-shopping-item", undoInput)).toBe("undone");
    expect(state.rpc).toEqual([
      { fn: "ora_undo_shopping_item", args: { p_item_id: ID, p_expected_revision: 1 } },
    ]);
  });

  it("refuses when edited, expired, missing, or the list is not reachable here", async () => {
    state.list = list([item({ revision: 3 })]);
    expect(await undoAction(personal, "add-shopping-item", undoInput)).toBe("changed");
    state.list = list([item({ createdAt: "2020-01-01T00:00:00Z" })]);
    expect(await undoAction(personal, "add-shopping-item", undoInput)).toBe("expired");
    state.list = list([]);
    expect(await undoAction(personal, "add-shopping-item", undoInput)).toBe("gone");
    state.list = { status: "not-found" };
    expect(await undoAction(inHome, "add-shopping-item", undoInput)).toBe("gone");
    expect(state.rpc).toEqual([]);
  });

  it("needs the list to find the item", async () => {
    const { listId: _listId, ...withoutList } = undoInput;
    expect(await undoAction(personal, "add-shopping-item", withoutList)).toBe("gone");
  });
});

describe("prepareTaskAction", () => {
  const row = (patch: object = {}) => ({
    id: ID,
    title: "Pay rent",
    listName: "Inbox",
    dueDate: "2026-12-01",
    completed: false,
    canComplete: true,
    recurring: false,
    ...patch,
  });

  it("offers open tasks the person can complete, with only what the picker shows", async () => {
    state.taskPage = {
      status: "ok",
      value: {
        tasks: [
          row(),
          row({ id: "b", canComplete: false }),
          row({ id: "c", completed: true }),
          row({ id: "d", recurring: true, dueDate: null }),
        ],
        total: 4,
      },
    };
    const result = await prepareTaskAction(inHome, "complete-task");
    expect(result).toEqual({
      status: "ok",
      preview: {
        action: "complete-task",
        tasks: [
          { id: ID, title: "Pay rent", listName: "Inbox", dueDate: "2026-12-01" },
          { id: "d", title: "Pay rent", listName: "Inbox", dueDate: null },
        ],
      },
    });
  });

  it("offers a due-date change only for tasks the person can edit", async () => {
    state.taskPage = {
      status: "ok",
      value: { tasks: [row(), row({ id: "b", canComplete: false })], total: 2 },
    };
    const result = await prepareTaskAction(personal, "change-task-due");
    expect(result.status === "ok" && result.preview.tasks.map((task) => task.id)).toEqual([ID]);
  });

  it("leaves repeating tasks out of a due-date change", async () => {
    state.taskPage = {
      status: "ok",
      value: { tasks: [row(), row({ id: "d", recurring: true })], total: 2 },
    };
    const result = await prepareTaskAction(personal, "change-task-due");
    expect(result.status === "ok" && result.preview.tasks.map((task) => task.id)).toEqual([ID]);
  });

  it("reports unavailable when tasks cannot be read", async () => {
    state.taskPage = { status: "unavailable" };
    expect(await prepareTaskAction(personal, "complete-task")).toEqual({ status: "unavailable" });
  });
});

describe("loadTaskEdit", () => {
  const detail = (patch: object = {}) => ({
    status: "ok",
    value: {
      id: ID,
      homeId: null,
      title: "Pay rent",
      description: "Monthly",
      startDate: null,
      dueDate: "2026-12-01",
      priority: "high",
      revision: 4,
      completedAt: null,
      series: null,
      list: { id: LIST, name: "Inbox", archived: false },
      labels: [{ id: "l1", name: "Home", color: null }],
      can: { edit: true },
      ...patch,
    },
  });

  it("returns the task as it is now, with its labels, so only the date changes", async () => {
    state.task = detail();
    expect(await loadTaskEdit(personal, ID)).toEqual({
      status: "ok",
      task: {
        id: ID,
        title: "Pay rent",
        description: "Monthly",
        startDate: null,
        dueDate: "2026-12-01",
        priority: "high",
        labelIds: ["l1"],
        revision: 4,
        listName: "Inbox",
      },
    });
  });

  it("returns nothing for a task that is elsewhere, done, repeating, missing or not editable", async () => {
    for (const patch of [
      { homeId: HOME },
      { completedAt: fresh() },
      { series: { id: "s" } },
      { can: { edit: false } },
    ]) {
      state.task = detail(patch);
      expect(await loadTaskEdit(personal, ID)).toEqual({ status: "ok", task: null });
    }
    state.task = { status: "not-found" };
    expect(await loadTaskEdit(personal, ID)).toEqual({ status: "ok", task: null });
    state.task = { status: "unavailable" };
    expect(await loadTaskEdit(personal, ID)).toEqual({ status: "unavailable" });
  });
});

describe("undoTaskEdit", () => {
  const detail = (patch: object = {}) => ({
    status: "ok",
    value: { homeId: null, revision: 5, updatedAt: fresh(), ...patch },
  });
  const completion = { step: "undo-completion" as const, id: ID, completedAt: fresh() };
  const due = { step: "undo-due" as const, id: ID, expectedRevision: 5, previousDue: "2026-12-01" };

  it("reopens a task whose completion still stands", async () => {
    state.task = detail();
    state.rpcResult = { data: [{ outcome: "reopened" }], error: null };
    expect(await undoTaskEdit(personal, "complete-task", completion)).toBe("undone");
    expect(state.rpc).toEqual([
      {
        fn: "ora_undo_task_completion",
        args: { p_task_id: ID, p_expected_completed_at: completion.completedAt },
      },
    ]);
  });

  it("answers changed when the database says someone reopened or changed it", async () => {
    state.task = detail();
    state.rpcResult = { data: [{ outcome: "conflict" }], error: null };
    expect(await undoTaskEdit(personal, "complete-task", completion)).toBe("changed");
    state.rpcResult = { data: [{ outcome: "list_unavailable" }], error: null };
    expect(await undoTaskEdit(personal, "complete-task", completion)).toBe("changed");
  });

  it("refuses a completion older than the window, without calling the database", async () => {
    state.task = detail();
    const old = new Date(Date.now() - UNDO_WINDOW_MS - 1000).toISOString();
    expect(await undoTaskEdit(personal, "complete-task", { ...completion, completedAt: old })).toBe(
      "expired",
    );
    expect(state.rpc).toEqual([]);
  });

  it("puts the old due date back when the task is still at the revision the change left", async () => {
    state.task = detail();
    state.rpcResult = { data: [{ outcome: "saved" }], error: null };
    expect(await undoTaskEdit(personal, "change-task-due", due)).toBe("undone");
    expect(state.rpc).toEqual([
      {
        fn: "ora_undo_task_due",
        args: { p_task_id: ID, p_expected_revision: 5, p_previous_due: "2026-12-01" },
      },
    ]);
  });

  it("restores 'no due date' by leaving the date out", async () => {
    state.task = detail();
    state.rpcResult = { data: [{ outcome: "saved" }], error: null };
    await undoTaskEdit(personal, "change-task-due", { ...due, previousDue: null });
    expect(state.rpc[0]?.args).toEqual({ p_task_id: ID, p_expected_revision: 5 });
  });

  it("refuses a due-date Undo after anyone edited the task, after the window, or elsewhere", async () => {
    state.task = detail({ revision: 6 });
    expect(await undoTaskEdit(personal, "change-task-due", due)).toBe("changed");
    state.task = detail({ updatedAt: new Date(Date.now() - UNDO_WINDOW_MS - 1000).toISOString() });
    expect(await undoTaskEdit(personal, "change-task-due", due)).toBe("expired");
    state.task = detail({ homeId: HOME });
    expect(await undoTaskEdit(personal, "change-task-due", due)).toBe("gone");
    state.task = { status: "not-found" };
    expect(await undoTaskEdit(personal, "change-task-due", due)).toBe("gone");
    expect(state.rpc).toEqual([]);
  });

  it("will not run another action's undo step, and never claims success on a failure", async () => {
    state.task = detail();
    expect(await undoTaskEdit(personal, "complete-task", due)).toBe("gone");
    expect(await undoTaskEdit(personal, "change-task-due", completion)).toBe("gone");
    state.rpcResult = { data: null, error: { code: "42501" } };
    expect(await undoTaskEdit(personal, "change-task-due", due)).toBe("not-permitted");
    state.rpcResult = { data: null, error: { code: "XX000" } };
    expect(await undoTaskEdit(personal, "change-task-due", due)).toBe("unavailable");
    state.task = { status: "unavailable" };
    expect(await undoTaskEdit(personal, "change-task-due", due)).toBe("unavailable");
  });
});
