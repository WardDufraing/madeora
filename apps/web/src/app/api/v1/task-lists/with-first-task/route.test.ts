import type { Mock } from "vitest";

import { POST } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";

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

function post(body: unknown, headers = sameOrigin): Request {
  return new Request("https://madeora.example/api/v1/task-lists/with-first-task", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function answer(row: Record<string, unknown> | null, error: unknown = null) {
  state.rpc.mockReturnValue({ data: row ? [row] : [], error });
}

const body = {
  homeId: HOME,
  list: { id: LIST, name: "  Errands " },
  task: {
    id: TASK,
    title: " Buy milk ",
    description: "",
    startDate: null,
    dueDate: "2026-10-20",
    priority: null,
    labelIds: [],
    assigneeIds: [],
  },
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("POST /api/v1/task-lists/with-first-task", () => {
  it("creates both with normalized names, leaving out empty optional fields", async () => {
    answer({ outcome: "created", list_revision: 1, task_revision: 1 });
    const response = await POST(post(body));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      listId: LIST,
      taskId: TASK,
      listRevision: 1,
      taskRevision: 1,
    });
    expect(state.rpc).toHaveBeenCalledWith("create_task_list_with_task", {
      p_list_id: LIST,
      p_list_name: "Errands",
      p_task_id: TASK,
      p_title: "Buy milk",
      p_due_date: "2026-10-20",
      p_label_ids: [],
      p_assignee_ids: [],
      p_home_id: HOME,
    });
  });

  it("answers a retry with 200", async () => {
    answer({ outcome: "exists", list_revision: 1, task_revision: 1 });
    expect((await POST(post(body))).status).toBe(200);
  });

  it.each([
    ["duplicate_name", 409, "duplicate-name"],
    ["limit_reached", 409, "limit-reached"],
    ["not_permitted", 403, "not-permitted"],
    ["list_id_taken", 409, "id-taken"],
    ["task_id_taken", 409, "id-taken"],
  ])("maps %s to %i", async (outcome, status, error) => {
    answer({ outcome, list_revision: null, task_revision: null });
    const response = await POST(post(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("names the field of a refused label or assignee", async () => {
    answer({ outcome: "invalid_label", list_revision: null, task_revision: null });
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", fields: ["labelIds"] });
  });

  it("refuses a cross-site request before touching the database", async () => {
    const response = await POST(
      post(body, { origin: "https://evil.example", host: "madeora.example" }),
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 401 without a verified identity", async () => {
    state.identity = null;
    expect((await POST(post(body))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses invalid input without calling the database", async () => {
    const bad = [
      { ...body, list: { id: LIST, name: " " } },
      { ...body, task: { ...body.task, startDate: "2026-10-21" } },
      { ...body, homeId: null, task: { ...body.task, assigneeIds: [LIST] } },
      { ...body, extra: true },
    ];
    for (const input of bad) {
      expect((await POST(post(input))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("hides database failures behind 500", async () => {
    answer(null, { code: "XX000", message: "secret detail" });
    const response = await POST(post(body));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
