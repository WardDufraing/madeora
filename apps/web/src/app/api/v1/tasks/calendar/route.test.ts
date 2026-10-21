import type { Mock } from "vitest";

import { GET } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
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

const get = (query: string) =>
  GET(new Request(`https://madeora.example/api/v1/tasks/calendar?${query}`));

const calendar = {
  today: "2026-10-20",
  truncated: false,
  undated: 2,
  entries: [
    {
      kind: "task",
      role: "due",
      date: "2026-10-21",
      taskId: TASK,
      listId: LIST,
      listName: "Chores",
      title: "Bins",
      startDate: null,
      dueDate: "2026-10-21",
      priority: null,
      completed: false,
      overdue: false,
      recurring: true,
      needsReassignment: false,
      subtasksDone: 0,
      subtasksTotal: 0,
      labelIds: [],
      assigneeIds: [MEMBER],
      canComplete: true,
      revision: 3,
    },
    {
      kind: "planned",
      role: "due",
      date: "2026-10-28",
      taskId: TASK,
      listId: LIST,
      listName: "Chores",
      title: "Bins",
      priority: null,
      recurring: true,
      needsReassignment: false,
      labelIds: [],
      assigneeIds: [MEMBER],
    },
  ],
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: calendar, error: null });
});

describe("GET /api/v1/tasks/calendar", () => {
  it("answers 401 without a verified session and reads nothing", async () => {
    state.identity = null;
    expect((await get("from=2026-10-19&to=2026-10-25")).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("returns the window's entries, read with the person's session and filters", async () => {
    const response = await get(
      `homeId=${HOME}&from=2026-10-19&to=2026-10-25&list=${LIST}&status=open&priority=high&priority=unset&assignee=member&member=${MEMBER}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(calendar);
    expect(state.rpc).toHaveBeenCalledWith("list_task_calendar", {
      p_home_id: HOME,
      p_from: "2026-10-19",
      p_to: "2026-10-25",
      p_today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown,
      p_list_id: LIST,
      p_status: "open",
      p_priorities: ["high", "unset"],
      p_assignee: "member",
      p_assignee_member: MEMBER,
    });
  });

  it.each([
    ["no window", ""],
    ["an end before the start", "from=2026-10-25&to=2026-10-19"],
    ["more than 42 days", "from=2026-10-01&to=2026-11-12"],
    ["a malformed date", "from=2026-13-01&to=2026-13-02"],
    ["an unknown status", "from=2026-10-19&to=2026-10-25&status=late"],
    ["a member filter without a member", "from=2026-10-19&to=2026-10-25&assignee=member"],
    ["a malformed Home", "homeId=x&from=2026-10-19&to=2026-10-25"],
  ])("rejects %s", async (_name, query) => {
    expect((await get(query)).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("allows exactly 42 days", async () => {
    expect((await get("from=2026-10-01&to=2026-11-11")).status).toBe(200);
  });

  it("answers 404 for a Home the person is not in", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501" } });
    expect((await get(`homeId=${HOME}&from=2026-10-19&to=2026-10-25`)).status).toBe(404);
  });

  it("answers 500 for a database failure or an unexpected answer", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "XX000" } });
    expect((await get("from=2026-10-19&to=2026-10-25")).status).toBe(500);
    state.rpc.mockReturnValue({ data: { entries: "nope" }, error: null });
    expect((await get("from=2026-10-19&to=2026-10-25")).status).toBe(500);
  });
});
