import { DELETE, GET, POST } from "./route";

interface State {
  identity: { userId: string } | null;
  context: { status: "ok" | "not-found" | "unavailable" };
  lookups: string[];
  record: "ok" | "forbidden" | "failed";
  recorded: unknown[];
  cleared: string[];
  clear: "ok" | "failed";
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok" },
  lookups: [],
  record: "ok",
  recorded: [],
  cleared: [],
  clear: "ok",
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/homes/server", () => ({
  getHomeContext: (homeId: string) => {
    state.lookups.push(homeId);
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
vi.mock("@/ora/history/server", () => ({
  loadHistory: (context: { home: { id: string } | null }) =>
    Promise.resolve({
      status: "ok",
      entries: [
        {
          id: "e1",
          kind: "task-added",
          label: context.home?.id ?? "personal",
          createdAt: "2026-11-16T09:00:00Z",
        },
      ],
    }),
  recordHistory: (...args: unknown[]) => {
    state.recorded.push(args.slice(1));
    return Promise.resolve(state.record);
  },
  clearHistory: (userId: string) => {
    state.cleared.push(userId);
    return Promise.resolve(state.clear);
  },
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const lineBody = { homeId: HOME_ID, kind: "task-added", label: "Water the plants" };

function send(method: "POST" | "DELETE", body: unknown, headers: Record<string, string> = {}) {
  const request = new Request("https://madeora.example/api/v1/ora/history", {
    method,
    headers: { "content-type": "application/json", ...sameOrigin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return method === "POST" ? POST(request) : DELETE(request);
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok" };
  state.lookups = [];
  state.record = "ok";
  state.recorded = [];
  state.cleared = [];
  state.clear = "ok";
});

describe("GET /api/v1/ora/history", () => {
  it("lists this place's lines, no-store, and refuses a Home that is not theirs", async () => {
    const own = await GET(new Request("https://madeora.example/api/v1/ora/history"));
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("no-store");
    expect(await own.json()).toMatchObject({ entries: [{ label: "personal" }] });
    const url = `https://madeora.example/api/v1/ora/history?homeId=${HOME_ID}`;
    state.context = { status: "not-found" };
    expect((await GET(new Request(url))).status).toBe(403);
    state.identity = null;
    expect((await GET(new Request(url))).status).toBe(401);
  });
});

describe("POST /api/v1/ora/history", () => {
  it("records one line in the person's own place", async () => {
    expect((await send("POST", lineBody)).status).toBe(201);
    expect(state.recorded).toEqual([["task-added", "Water the plants"]]);
  });

  it("refuses a foreign Home, cross-site, unknown kinds, empty labels and extra fields", async () => {
    state.context = { status: "not-found" };
    expect((await send("POST", lineBody)).status).toBe(403);
    state.context = { status: "ok" };
    expect((await send("POST", lineBody, { origin: "https://evil.example" })).status).toBe(403);
    expect((await send("POST", { ...lineBody, kind: "free-text" })).status).toBe(400);
    expect((await send("POST", { ...lineBody, label: "  " })).status).toBe(400);
    expect((await send("POST", { ...lineBody, label: "x".repeat(201) })).status).toBe(400);
    expect((await send("POST", { ...lineBody, extra: 1 })).status).toBe(400);
    expect(state.recorded).toEqual([]);
  });

  it("passes on a failed write honestly", async () => {
    state.record = "failed";
    expect((await send("POST", lineBody)).status).toBe(500);
    state.record = "forbidden";
    expect((await send("POST", lineBody)).status).toBe(403);
  });
});

describe("DELETE /api/v1/ora/history (Clear recent interactions)", () => {
  it("clears only the signed-in person's lines", async () => {
    expect((await send("DELETE", {})).status).toBe(200);
    expect(state.cleared).toEqual(["user-a"]);
  });

  it("needs a session, same origin and an empty JSON object", async () => {
    state.identity = null;
    expect((await send("DELETE", {})).status).toBe(401);
    state.identity = { userId: "user-a" };
    expect((await send("DELETE", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await send("DELETE", { userId: "user-b" })).status).toBe(400);
    expect(state.cleared).toEqual([]);
    state.clear = "failed";
    expect((await send("DELETE", {})).status).toBe(500);
  });
});
