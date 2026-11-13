import { POST } from "./route";

interface State {
  identity: { userId: string } | null;
  context: { status: "ok" | "not-found" | "unavailable" };
  claim: unknown;
  claims: number;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok" },
  claim: { status: "ok", teaser: null },
  claims: 0,
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const teaser = { kind: "today-overview", situation: "2026-11-16", count: 2 };

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
vi.mock("@/ora/suggestions/server", () => ({
  claimTeaser: () => {
    state.claims += 1;
    return Promise.resolve(state.claim);
  },
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://madeora.example/api/v1/ora/teaser", {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok" };
  state.claim = { status: "ok", teaser: null };
  state.claims = 0;
});

describe("POST /api/v1/ora/teaser", () => {
  it("returns the teaser the database granted", async () => {
    state.claim = { status: "ok", teaser };
    const response = await post({ homeId: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ teaser });
  });

  it("returns none when the daily teaser is used up or muted", async () => {
    expect(await (await post({ homeId: HOME_ID })).json()).toEqual({ teaser: null });
  });

  it("claims nothing, and answers no teaser with 200, for a signed-out visitor or a foreign Home", async () => {
    state.identity = null;
    expect(await (await post({ homeId: null })).json()).toEqual({ teaser: null });
    state.identity = { userId: "user-a" };
    state.context = { status: "not-found" };
    const foreign = await post({ homeId: HOME_ID });
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ teaser: null });
    expect(state.claims).toBe(0);
  });

  it("refuses a bad request or a cross-site one before claiming anything", async () => {
    expect((await post({ homeId: "nope" })).status).toBe(400);
    expect((await post({ homeId: null }, { origin: "https://evil.example" })).status).toBe(403);
    expect(state.claims).toBe(0);
  });

  it("answers no teaser when it cannot be worked out", async () => {
    state.claim = { status: "unavailable" };
    expect(await (await post({ homeId: null })).json()).toEqual({ teaser: null });
  });
});
