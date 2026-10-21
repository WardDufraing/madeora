import type { Mock } from "vitest";

import { GET } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));

const get = (query = "") =>
  GET(new Request(`https://madeora.example/api/v1/tasks/options${query}`));

const lists = [
  {
    id: LIST,
    name: "Groceries",
    position: 0,
    archived: false,
    revision: 1,
    open_tasks: 2,
    active_tasks: 2,
  },
];
const labels = [{ id: "l1", name: "Urgent", color: "red", revision: 1, task_count: 0 }];
const directory = [{ membership_id: "m1", name: "Sam", is_self: true }];

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockImplementation((name) => {
    if (name === "list_task_lists") return { data: lists, error: null };
    if (name === "list_task_labels") return { data: labels, error: null };
    if (name === "home_directory") return { data: directory, error: null };
    return { data: null, error: { code: "XX000" } };
  });
});

describe("GET /api/v1/tasks/options", () => {
  it("answers 401 without a verified session and reads nothing", async () => {
    state.identity = null;
    expect((await get()).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("gives the Personal space's lists and labels, without members", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lists: [{ id: LIST, name: "Groceries", archived: false }],
      labels: [{ id: "l1", name: "Urgent", color: "red" }],
      members: [],
    });
    expect(state.rpc.mock.calls.map(([name]) => name)).not.toContain("home_directory");
  });

  it("reads a Home's options with the person's own session, including archived lists", async () => {
    const response = await get(`?homeId=${HOME}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { members: unknown }).members).toEqual([
      { id: "m1", name: "Sam", isSelf: true },
    ]);
    expect(state.rpc).toHaveBeenCalledWith(
      "list_task_lists",
      expect.objectContaining({ p_home_id: HOME, p_include_archived: true }),
    );
  });

  it("answers 404 for a Home the person is not in, like one that does not exist", async () => {
    state.rpc.mockImplementation(() => ({ data: null, error: { code: "42501" } }));
    expect((await get(`?homeId=${HOME}`)).status).toBe(404);
  });

  it("rejects a malformed Home id", async () => {
    expect((await get("?homeId=not-a-uuid")).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 500 when the database fails", async () => {
    state.rpc.mockImplementation(() => ({ data: null, error: { code: "XX000" } }));
    expect((await get()).status).toBe(500);
  });
});
