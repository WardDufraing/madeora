import type { Mock } from "vitest";

import { POST } from "./route";

type Role = "owner" | "administrator" | "member";
interface State {
  identity: { userId: string } | null;
  context: { status: "ok"; role: Role } | { status: "not-found" } | { status: "unavailable" };
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "member" },
  rpc: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const CASE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const REQUEST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
const STATEMENT =
  "The Owner moved abroad and has not answered calls or email since March. You can call me.";

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
        membership: { homeId, role: state.context.role, grantedCapabilities: new Set() },
      },
    });
  },
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

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${HOME_ID}/ownership-recoveries`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId: HOME_ID }) },
  );
}

const valid = { statement: STATEMENT, requestId: REQUEST_ID };

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "member" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({
    data: [{ outcome: "submitted", recovery_id: CASE_ID }],
    error: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/ownership-recoveries", () => {
  it.each<Role>(["member", "administrator"])("lets a %s ask for a review", async (role) => {
    state.context = { status: "ok", role };
    const response = await post(valid);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ recovery: { id: CASE_ID } });
    expect(state.rpc).toHaveBeenCalledWith("request_ownership_recovery", {
      p_home_id: HOME_ID,
      p_statement: STATEMENT,
      p_request_id: REQUEST_ID,
    });
  });

  it("refuses the Owner before the database", async () => {
    state.context = { status: "ok", role: "owner" };
    expect((await post(valid)).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["not_permitted", 403, "not-permitted"],
    ["already_open", 409, "already-open"],
    ["not_found", 404, "not-found"],
  ])("maps the database's %s", async (outcome, status, error) => {
    state.rpc.mockReturnValue({ data: [{ outcome, recovery_id: null }], error: null });
    const response = await post(valid);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("refuses a short statement, a missing request id and extra fields", async () => {
    const short = await post({ ...valid, statement: "Too short." });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "invalid", fields: ["statement"] });
    expect((await post({ statement: STATEMENT })).status).toBe(400);
    expect((await post({ ...valid, ownerId: "x" })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 outside the Home and 401 when signed out", async () => {
    state.context = { status: "not-found" };
    expect((await post(valid)).status).toBe(404);
    state.identity = null;
    expect((await post(valid)).status).toBe(401);
  });

  it("refuses a cross-site request", async () => {
    expect((await post(valid, { origin: "https://evil.example" })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps database errors without leaking them", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "22023" } });
    expect((await post(valid)).status).toBe(400);
    state.rpc.mockReturnValue({ data: null, error: { code: "XX000" } });
    const response = await post(valid);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "failed" });
  });
});
