import { GET, POST } from "./route";

interface State {
  identity: { userId: string } | null;
  context: { status: "ok" | "not-found" | "unavailable" };
  lookups: string[];
  dismiss: "ok" | "forbidden" | "failed";
  dismissed: unknown[];
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok" },
  lookups: [],
  dismiss: "ok",
  dismissed: [],
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
vi.mock("@/ora/suggestions/server", () => ({
  loadSuggestions: (context: { home: { id: string } | null }) =>
    Promise.resolve({
      status: "ok",
      today: "2026-11-16",
      suggestions: [
        { kind: "today-overview", situation: context.home?.id ?? "personal", count: 2 },
      ],
    }),
  dismissSuggestion: (...args: unknown[]) => {
    state.dismissed.push(args.slice(1));
    return Promise.resolve(state.dismiss);
  },
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const dismissBody = { homeId: HOME_ID, kind: "today-overview", situation: "2026-11-16" };

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://madeora.example/api/v1/ora/suggestions", {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok" };
  state.lookups = [];
  state.dismiss = "ok";
  state.dismissed = [];
});

describe("GET /api/v1/ora/suggestions", () => {
  it("lists the person's suggestions for Personal space without looking up a Home", async () => {
    const response = await GET(new Request("https://madeora.example/api/v1/ora/suggestions"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      suggestions: [{ kind: "today-overview", situation: "personal", count: 2 }],
    });
    expect(state.lookups).toEqual([]);
  });

  it("answers 401 signed out, and 403 for a Home that is not theirs", async () => {
    const url = `https://madeora.example/api/v1/ora/suggestions?homeId=${HOME_ID}`;
    state.context = { status: "not-found" };
    expect((await GET(new Request(url))).status).toBe(403);
    state.identity = null;
    expect((await GET(new Request(url))).status).toBe(401);
  });
});

describe("POST /api/v1/ora/suggestions (dismiss)", () => {
  it("dismisses a suggestion in the person's own Home", async () => {
    expect((await post(dismissBody)).status).toBe(200);
    expect(state.dismissed).toEqual([["today-overview", "2026-11-16"]]);
    expect(state.lookups).toEqual([HOME_ID]);
  });

  it("refuses a Home the person does not belong to without dismissing anything", async () => {
    state.context = { status: "not-found" };
    expect((await post(dismissBody)).status).toBe(403);
    expect(state.dismissed).toEqual([]);
  });

  it("refuses cross-site requests, non-JSON, unknown kinds and extra fields", async () => {
    expect((await post(dismissBody, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("nope")).status).toBe(400);
    expect((await post({ ...dismissBody, kind: "other" })).status).toBe(400);
    expect((await post({ ...dismissBody, extra: 1 })).status).toBe(400);
    expect(state.dismissed).toEqual([]);
  });

  it("answers 401 signed out and passes on a refusal or failure honestly", async () => {
    state.dismiss = "forbidden";
    expect((await post(dismissBody)).status).toBe(403);
    state.dismiss = "failed";
    expect((await post(dismissBody)).status).toBe(500);
    state.identity = null;
    expect((await post(dismissBody)).status).toBe(401);
  });
});
