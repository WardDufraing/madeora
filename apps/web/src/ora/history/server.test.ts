import { clearHistory, loadHistory, recordHistory } from "./server";

interface State {
  rows: unknown[];
  readError: { code: string } | null;
  writeError: { code: string } | null;
  inserts: unknown[];
  filters: [string, string][];
  deletes: [string, string][];
}
const state = vi.hoisted((): State => ({
  rows: [],
  readError: null,
  writeError: null,
  inserts: [],
  filters: [],
  deletes: [],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      from: () => ({
        select: () => ({
          eq: (column: string, value: string) => {
            state.filters.push([column, value]);
            return {
              order: () => ({
                limit: () => Promise.resolve({ data: state.rows, error: state.readError }),
              }),
            };
          },
        }),
        insert: (row: unknown) => {
          state.inserts.push(row);
          return Promise.resolve({ error: state.writeError });
        },
        delete: () => ({
          eq: (column: string, value: string) => {
            state.deletes.push([column, value]);
            return Promise.resolve({ error: state.writeError });
          },
        }),
      }),
    }),
}));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const inHome = {
  home: {
    id: HOME,
    membership: { homeId: HOME, role: "member" as const, grantedCapabilities: new Set<never>() },
  },
};

beforeEach(() => {
  state.rows = [];
  state.readError = null;
  state.writeError = null;
  state.inserts = [];
  state.filters = [];
  state.deletes = [];
});

describe("loadHistory", () => {
  it("reads only this place, maps the rows and drops a kind it does not know", async () => {
    state.rows = [
      { id: "a", kind: "task-added", label: "Milk", created_at: "2026-11-16T09:00:00Z" },
      { id: "b", kind: "something-else", label: "x", created_at: "2026-11-16T08:00:00Z" },
    ];
    expect(await loadHistory({ home: null })).toEqual({
      status: "ok",
      entries: [{ id: "a", kind: "task-added", label: "Milk", createdAt: "2026-11-16T09:00:00Z" }],
    });
    await loadHistory(inHome);
    expect(state.filters).toEqual([
      ["scope", "personal"],
      ["scope", HOME],
    ]);
  });

  it("is unavailable when the read fails", async () => {
    state.readError = { code: "XX000" };
    expect(await loadHistory({ home: null })).toEqual({ status: "unavailable" });
  });
});

describe("recordHistory and clearHistory", () => {
  it("writes one line scoped to the place, and maps a refusal and a failure", async () => {
    expect(await recordHistory(inHome, "task-added", "Milk")).toBe("ok");
    expect(state.inserts).toEqual([
      { scope: HOME, home_id: HOME, kind: "task-added", label: "Milk" },
    ]);
    state.writeError = { code: "42501" };
    expect(await recordHistory(inHome, "task-added", "Milk")).toBe("forbidden");
    state.writeError = { code: "XX000" };
    expect(await recordHistory({ home: null }, "task-undone", "Milk")).toBe("failed");
  });

  it("clears the signed-in person's own lines only", async () => {
    expect(await clearHistory("user-a")).toBe("ok");
    expect(state.deletes).toEqual([["user_id", "user-a"]]);
    state.writeError = { code: "XX000" };
    expect(await clearHistory("user-a")).toBe("failed");
  });
});
