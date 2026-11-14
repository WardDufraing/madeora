import { DELETE, POST } from "./route";

interface State {
  identity: { userId: string } | null;
  context: { status: "ok" | "not-found" | "unavailable" };
  canCreate: boolean;
  destinations: { id: string; name: string }[];
  saved: unknown[];
  save: "ok" | "forbidden" | "not-found" | "failed";
  deleted: unknown[];
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok" },
  canCreate: true,
  destinations: [{ id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00bb", name: "Inbox" }],
  saved: [],
  save: "ok",
  deleted: [],
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00bb";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/homes/server", () => ({
  getHomeContext: (homeId: string) => {
    if (state.context.status !== "ok") return Promise.resolve(state.context);
    return Promise.resolve({
      status: "ok",
      context: {
        home: { id: homeId, name: "Thuis", timeZone: "Europe/Brussels" },
        membership: { homeId, role: "member", grantedCapabilities: new Set() },
      },
    });
  },
}));
vi.mock("@/ora/tools/registry", () => ({
  findInputTool: () => (state.canCreate ? { id: "add-task" } : undefined),
}));
vi.mock("@/ora/actions/server", () => ({
  prepareAction: () =>
    Promise.resolve({
      status: "ok",
      preview: { action: "add-task", destinations: state.destinations, remembered: null },
    }),
}));
vi.mock("@/ora/memories/server", () => ({
  saveMemory: (...args: unknown[]) => {
    state.saved.push(args.slice(1));
    return Promise.resolve(state.save);
  },
  deleteMemory: (...args: unknown[]) => {
    state.deleted.push(args);
    return Promise.resolve("ok");
  },
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const body = { homeId: HOME_ID, action: "add-task", listId: LIST_ID };

function send(method: "POST" | "DELETE", payload: unknown, headers: Record<string, string> = {}) {
  const request = new Request("https://madeora.example/api/v1/ora/memories", {
    method,
    headers: { "content-type": "application/json", ...sameOrigin, ...headers },
    body: JSON.stringify(payload),
  });
  return method === "POST" ? POST(request) : DELETE(request);
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok" };
  state.canCreate = true;
  state.saved = [];
  state.save = "ok";
  state.deleted = [];
});

describe("POST /api/v1/ora/memories", () => {
  it("remembers a list the person can add to, using the server's own list of destinations", async () => {
    expect((await send("POST", body)).status).toBe(200);
    expect(state.saved).toEqual([["add-task", LIST_ID, state.destinations]]);
  });

  it("refuses without the action's permission, a foreign Home, signed out, cross-site and bad input", async () => {
    state.canCreate = false;
    expect((await send("POST", body)).status).toBe(403);
    state.canCreate = true;
    state.context = { status: "not-found" };
    expect((await send("POST", body)).status).toBe(403);
    state.context = { status: "ok" };
    state.identity = null;
    expect((await send("POST", body)).status).toBe(401);
    state.identity = { userId: "user-a" };
    expect((await send("POST", body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await send("POST", { ...body, action: "delete-everything" })).status).toBe(400);
    expect((await send("POST", { ...body, listId: "not-an-id" })).status).toBe(400);
    expect((await send("POST", { ...body, listName: "Mine" })).status).toBe(400);
    expect(state.saved).toEqual([]);
  });

  it("says not-found for a list that is not on offer, and passes on failures", async () => {
    state.save = "not-found";
    expect((await send("POST", body)).status).toBe(404);
    state.save = "failed";
    expect((await send("POST", body)).status).toBe(500);
  });
});

describe("DELETE /api/v1/ora/memories", () => {
  it("forgets one memory of the signed-in person only", async () => {
    expect((await send("DELETE", { homeId: HOME_ID, key: "task-list" })).status).toBe(200);
    expect(state.deleted).toEqual([["user-a", HOME_ID, "task-list"]]);
  });

  it("needs a session and a known key", async () => {
    expect((await send("DELETE", { homeId: null, key: "everything" })).status).toBe(400);
    state.identity = null;
    expect((await send("DELETE", { homeId: null, key: "task-list" })).status).toBe(401);
    expect(state.deleted).toEqual([]);
  });
});
