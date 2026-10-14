import type { Mock } from "vitest";

import { POST } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

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

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://madeora.example/api/v1/join-requests", {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockImplementation(() => ({
    data: [{ outcome: "requested", request_id: "r", home_name: "Thuis" }],
    error: null,
  }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/join-requests", () => {
  it("asks to join with the token as given, answering only the outcome", async () => {
    const response = await post({ token: " abcde-12345 " });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ outcome: "requested" });
    expect(state.rpc).toHaveBeenCalledWith("request_to_join_home", { p_token: "abcde-12345" });
  });

  it.each([
    "pending",
    "invalid",
    "expired",
    "revoked",
    "used_up",
    "email_mismatch",
    "already_member",
    "declined",
    "rate_limited",
  ])("answers %s as a normal outcome, without the Home's name", async (outcome) => {
    state.rpc.mockImplementation(() => ({
      data: [{ outcome, request_id: null, home_name: outcome === "pending" ? "Thuis" : null }],
      error: null,
    }));
    const response = await post({ token: "x".repeat(43) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome });
  });

  it("answers 500 for an outcome it does not know", async () => {
    state.rpc.mockImplementation(() => ({ data: [{ outcome: "surprise" }], error: null }));
    expect((await post({ token: "x" })).status).toBe(500);
  });

  it("answers 401 for a session without a confirmed email", async () => {
    state.rpc.mockImplementation(() => ({ data: null, error: { code: "42501", message: "x" } }));
    expect((await post({ token: "x" })).status).toBe(401);
  });

  it.each([
    ["an empty token", { token: "  " }],
    ["a very long token", { token: "x".repeat(101) }],
    ["extra fields", { token: "x", homeId: "y" }],
    ["not JSON", "{"],
  ])("refuses %s", async (_, body) => {
    expect((await post(body)).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request (CSRF)", async () => {
    expect((await post({ token: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    state.identity = null;
    expect((await post({ token: "x" })).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
