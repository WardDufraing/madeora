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
  context: { status: "ok", role: "owner" },
  rpc: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const REQUEST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0004";

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

function post(body: unknown, headers: Record<string, string> = {}, requestId = REQUEST_ID) {
  return POST(
    new Request(
      `https://madeora.example/api/v1/homes/${HOME_ID}/join-requests/${requestId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin, ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ homeId: HOME_ID, requestId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "owner" };
  state.rpc.mockReset();
  state.rpc.mockImplementation((_, args) => ({
    data: args.p_decision === "approve" ? "approved" : "declined",
    error: null,
  }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/join-requests/{id}/decision", () => {
  it.each([
    ["approve", "approved"],
    ["decline", "declined"],
  ])("%s decides the request in exactly this Home", async (decision, outcome) => {
    const response = await post({ decision });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome });
    expect(state.rpc).toHaveBeenCalledWith("decide_join_request", {
      p_home_id: HOME_ID,
      p_request_id: REQUEST_ID,
      p_decision: decision,
    });
  });

  it.each([
    ["already_decided", 409, "already-decided"],
    ["no_longer_valid", 409, "no-longer-valid"],
    ["already_member", 409, "already-member"],
    ["not_permitted", 403, "not-permitted"],
    ["not_found", 404, "not-found"],
  ])("maps the outcome %s", async (outcome, status, error) => {
    state.rpc.mockImplementation(() => ({ data: outcome, error: null }));
    const response = await post({ decision: "approve" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it.each<Role>(["administrator", "member"])(
    "refuses a %s without the capability",
    async (role) => {
      state.context = { status: "ok", role };
      expect((await post({ decision: "approve" })).status).toBe(403);
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for a Home the person does not belong to", async () => {
    state.context = { status: "not-found" };
    expect((await post({ decision: "approve" })).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed request id", async () => {
    expect((await post({ decision: "approve" }, {}, "x")).status).toBe(404);
  });

  it.each([
    ["an unknown decision", { decision: "maybe" }],
    ["a role in the body", { decision: "approve", role: "administrator" }],
    ["no decision", {}],
  ])("refuses %s", async (_, body) => {
    expect((await post(body)).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request (CSRF)", async () => {
    expect((await post({ decision: "approve" }, { origin: "https://evil.example" })).status).toBe(
      403,
    );
  });

  it("refuses a signed-out request", async () => {
    state.identity = null;
    expect((await post({ decision: "approve" })).status).toBe(401);
  });

  it("answers 500 on an unexpected database error", async () => {
    state.rpc.mockImplementation(() => ({ data: null, error: { code: "XX000", message: "x" } }));
    expect((await post({ decision: "approve" })).status).toBe(500);
  });
});
