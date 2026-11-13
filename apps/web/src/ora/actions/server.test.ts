import { prepareAction, undoAction } from "./server";
import { UNDO_WINDOW_MS } from "./types";

interface State {
  rpc: { fn: string; args: unknown }[];
  rpcResult: {
    data: { outcome: string; entry_id: string }[] | null;
    error: { code: string } | null;
  };
  task: unknown;
  list: unknown;
  taskLists: unknown;
  shoppingLists: unknown;
}
const state = vi.hoisted((): State => ({
  rpc: [],
  rpcResult: { data: [{ outcome: "deleted", entry_id: "e" }], error: null },
  task: { status: "not-found" },
  list: { status: "not-found" },
  taskLists: { status: "ok", value: [] },
  shoppingLists: { status: "ok", value: [] },
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
vi.mock("@/tasks/data", () => ({
  getTask: () => Promise.resolve(state.task),
  listTaskLists: () => Promise.resolve(state.taskLists),
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
  state.rpc = [];
  state.rpcResult = { data: [{ outcome: "deleted", entry_id: "e" }], error: null };
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
      preview: { action: "add-task", destinations: [{ id: "a", name: "Inbox" }] },
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
    expect(state.rpc).toEqual([{ fn: "delete_task", args: { p_task_id: ID } }]);
  });

  it("does nothing when anyone changed it since (never overwrites their edit)", async () => {
    state.task = task({ revision: 2 });
    expect(await undoAction(personal, "add-task", undoInput)).toBe("changed");
    expect(state.rpc).toEqual([]);
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
    state.rpcResult = { data: [{ outcome: "not_found", entry_id: "" }], error: null };
    expect(await undoAction(personal, "add-task", undoInput)).toBe("gone");
  });

  it("is not permitted when the database refuses", async () => {
    state.task = task();
    state.rpcResult = { data: null, error: { code: "42501" } };
    expect(await undoAction(personal, "add-task", undoInput)).toBe("not-permitted");
    state.rpcResult = { data: [{ outcome: "not_permitted", entry_id: "" }], error: null };
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
    expect(state.rpc).toEqual([{ fn: "delete_shopping_item", args: { p_item_id: ID } }]);
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
