import { deleteMemory, listMemories, loadRemembered, saveMemory } from "./server";

interface State {
  row: { list_id: string } | null;
  rows: unknown[];
  readError: { code: string } | null;
  writeError: { code: string } | null;
  upserts: unknown[];
  filters: [string, string][];
}
const state = vi.hoisted((): State => ({
  row: null,
  rows: [],
  readError: null,
  writeError: null,
  upserts: [],
  filters: [],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      from: () => {
        const chain = {
          eq: (column: string, value: string) => {
            state.filters.push([column, value]);
            return chain;
          },
          maybeSingle: () => Promise.resolve({ data: state.row, error: state.readError }),
          order: () => Promise.resolve({ data: state.rows, error: state.readError }),
          then: (resolve: (value: unknown) => void) => {
            resolve({ error: state.writeError });
          },
        };
        return {
          select: () => chain,
          delete: () => chain,
          upsert: (row: unknown) => {
            state.upserts.push(row);
            return Promise.resolve({ error: state.writeError });
          },
        };
      },
    }),
}));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00bb";
const inHome = {
  home: {
    id: HOME,
    membership: { homeId: HOME, role: "member" as const, grantedCapabilities: new Set<never>() },
  },
};
const destinations = [{ id: LIST, name: "Inbox" }];

beforeEach(() => {
  state.row = null;
  state.rows = [];
  state.readError = null;
  state.writeError = null;
  state.upserts = [];
  state.filters = [];
});

describe("loadRemembered", () => {
  it("returns the remembered list only while it is still on offer", async () => {
    state.row = { list_id: LIST };
    expect(await loadRemembered(inHome, "add-task", destinations)).toBe(LIST);
    expect(state.filters).toEqual([
      ["scope", HOME],
      ["key", "task-list"],
    ]);
    expect(await loadRemembered(inHome, "add-task", [])).toBeNull();
  });

  it("answers none when nothing is remembered or the read fails", async () => {
    expect(await loadRemembered({ home: null }, "add-shopping-item", destinations)).toBeNull();
    state.readError = { code: "XX000" };
    state.row = { list_id: LIST };
    expect(await loadRemembered({ home: null }, "add-task", destinations)).toBeNull();
  });
});

describe("saveMemory", () => {
  it("saves the server's own name for a list on offer, scoped to the place", async () => {
    expect(await saveMemory(inHome, "add-task", LIST, destinations)).toBe("ok");
    expect(state.upserts).toEqual([
      { scope: HOME, home_id: HOME, key: "task-list", list_id: LIST, list_name: "Inbox" },
    ]);
  });

  it("refuses a list that is not on offer and maps a refusal and a failure", async () => {
    expect(await saveMemory(inHome, "add-task", LIST, [])).toBe("not-found");
    expect(state.upserts).toEqual([]);
    state.writeError = { code: "42501" };
    expect(await saveMemory(inHome, "add-task", LIST, destinations)).toBe("forbidden");
    state.writeError = { code: "XX000" };
    expect(await saveMemory({ home: null }, "add-shopping-item", LIST, destinations)).toBe(
      "failed",
    );
  });
});

describe("deleteMemory and listMemories", () => {
  it("forgets one memory of this person in this place", async () => {
    expect(await deleteMemory("user-a", null, "shopping-list")).toBe("ok");
    expect(state.filters).toEqual([
      ["user_id", "user-a"],
      ["scope", "personal"],
      ["key", "shopping-list"],
    ]);
    state.writeError = { code: "XX000" };
    expect(await deleteMemory("user-a", HOME, "task-list")).toBe("failed");
  });

  it("lists what is remembered and skips a key it does not know", async () => {
    state.rows = [
      { key: "task-list", home_id: null, list_name: "Inbox" },
      { key: "other", home_id: null, list_name: "x" },
    ];
    expect(await listMemories()).toEqual({
      status: "ok",
      memories: [{ key: "task-list", homeId: null, listName: "Inbox" }],
    });
    state.readError = { code: "XX000" };
    expect(await listMemories()).toEqual({ status: "unavailable" });
  });
});
