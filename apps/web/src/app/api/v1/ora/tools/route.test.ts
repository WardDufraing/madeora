import { GET, POST } from "./route";

type Role = "owner" | "administrator" | "member";
interface State {
  identity: { userId: string } | null;
  context: { status: "ok"; role: Role } | { status: "not-found" } | { status: "unavailable" };
  lookups: string[];
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "member" },
  lookups: [],
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OTHER_HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";

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
        membership: { homeId, role: state.context.role, grantedCapabilities: new Set() },
      },
    });
  },
}));
vi.mock("@/ora/overview/server", () => ({
  loadOverview: (context: { home: { id: string } | null }) =>
    Promise.resolve({
      status: "ok",
      overview: { homeId: context.home?.id ?? null, days: [], notices: [] },
    }),
}));
vi.mock("@/ora/overview/share-server", () => ({
  prepareShare: () => Promise.resolve({ status: "invalid" }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function get(homeId?: string) {
  const query = homeId === undefined ? "" : `?homeId=${homeId}`;
  return GET(new Request(`https://madeora.example/api/v1/ora/tools${query}`));
}
function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://madeora.example/api/v1/ora/tools", {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "member" };
  state.lookups = [];
});

describe("GET /api/v1/ora/tools", () => {
  it("lists the Personal tools without looking at any Home", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { tools: { id: string }[] };
    expect(body.tools.map((tool) => tool.id)).toContain("open-tasks");
    expect(body.tools.map((tool) => tool.id)).not.toContain("open-chores");
    expect(state.lookups).toEqual([]);
  });

  it("lists a Member's tools in a Home, without the management pages", async () => {
    const body = (await (await get(HOME_ID)).json()) as { tools: { id: string }[] };
    const ids = body.tools.map((tool) => tool.id);
    expect(ids).toContain("open-chores");
    expect(ids).not.toContain("open-home-settings");
    expect(state.lookups).toEqual([HOME_ID]);
  });

  it("lists the management pages for the Owner", async () => {
    state.context = { status: "ok", role: "owner" };
    const body = (await (await get(HOME_ID)).json()) as { tools: { id: string }[] };
    expect(body.tools.map((tool) => tool.id)).toContain("open-home-settings");
  });

  it("answers 401 when signed out, before any lookup", async () => {
    state.identity = null;
    expect((await get(HOME_ID)).status).toBe(401);
    expect(state.lookups).toEqual([]);
  });

  it("answers 403 for a Home the person does not belong to, and for a malformed id", async () => {
    state.context = { status: "not-found" };
    expect((await get(OTHER_HOME_ID)).status).toBe(403);
    expect((await get("not-a-uuid")).status).toBe(403);
  });

  it("answers 503 when the membership cannot be read, never an open list", async () => {
    state.context = { status: "unavailable" };
    const response = await get(HOME_ID);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});

describe("POST /api/v1/ora/tools", () => {
  it("runs a tool the person may use, resolved for their own Home", async () => {
    const response = await post({ tool: "open-chores", homeId: HOME_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      output: { kind: "navigate", href: `/homes/${HOME_ID}/chores` },
    });
  });

  it("refuses a tool the Member lacks the permission for, like an unknown one", async () => {
    const denied = await post({ tool: "open-home-settings", homeId: HOME_ID });
    const unknown = await post({ tool: "no-such-tool", homeId: HOME_ID });
    expect(denied.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await denied.json()).toEqual(await unknown.json());
  });

  it("lets the Owner run the same tool", async () => {
    state.context = { status: "ok", role: "owner" };
    const response = await post({ tool: "open-home-settings", homeId: HOME_ID });
    expect(response.status).toBe(200);
  });

  it("checks the permission afresh on each call: a revoked member is refused at once", async () => {
    expect((await post({ tool: "open-chores", homeId: HOME_ID })).status).toBe(200);
    state.context = { status: "not-found" };
    expect((await post({ tool: "open-chores", homeId: HOME_ID })).status).toBe(403);
  });

  it("refuses a Home tool in Personal space", async () => {
    expect((await post({ tool: "open-chores", homeId: null })).status).toBe(403);
    expect((await post({ tool: "open-chores" })).status).toBe(403);
  });

  it("refuses cross-site requests, other content types, extra fields and signed-out callers", async () => {
    expect((await post({ tool: "open-tasks" }, { origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await post({ tool: "open-tasks" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ tool: "open-tasks", userId: "user-b" })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    state.identity = null;
    expect((await post({ tool: "open-tasks" })).status).toBe(401);
  });
});

describe("POST /api/v1/ora/tools: overview input (S46)", () => {
  const overview = { target: "today" };

  it("runs an overview for the place resolved on the server, never the one the body names", async () => {
    const personalRun = await post({ tool: "overview", homeId: null, input: overview });
    expect(personalRun.status).toBe(200);
    const body = (await personalRun.json()) as {
      output: { kind: string; overview: { homeId: unknown } };
    };
    expect(body.output.kind).toBe("overview");
    expect(body.output.overview.homeId).toBeNull();

    const homeRun = await post({ tool: "overview", homeId: HOME_ID, input: overview });
    const homeBody = (await homeRun.json()) as { output: { overview: { homeId: unknown } } };
    expect(homeBody.output.overview.homeId).toBe(HOME_ID);
  });

  it("refuses a Home the person is not in, before reading anything", async () => {
    state.context = { status: "not-found" };
    expect((await post({ tool: "overview", homeId: OTHER_HOME_ID, input: overview })).status).toBe(
      403,
    );
  });

  it("rejects input that does not fit, including unknown and conflicting fields", async () => {
    for (const input of [
      {},
      { target: "month" },
      { target: "day" },
      { target: "day", date: "2026-02-31" },
      { target: "day", date: "9999-12-31" },
      { target: "today", date: "2026-10-01" },
      { target: "today", extra: 1 },
      { target: "today", filters: { assignee: "member" } },
      { target: "today", filters: { modules: ["photos"] } },
    ]) {
      expect((await post({ tool: "overview", homeId: HOME_ID, input })).status).toBe(400);
    }
  });

  it("refuses sharing in Personal space and answers a bad audience as invalid", async () => {
    const request = { target: "today" };
    const audience = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0099";
    expect(
      (await post({ tool: "share-overview", homeId: null, input: { request, audience } })).status,
    ).toBe(403);
    expect(
      (await post({ tool: "share-overview", homeId: HOME_ID, input: { request, audience } }))
        .status,
    ).toBe(400);
    expect(
      (await post({ tool: "share-overview", homeId: HOME_ID, input: { request } })).status,
    ).toBe(400);
  });
});
