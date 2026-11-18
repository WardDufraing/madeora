import type { Mock } from "vitest";

import { POST } from "./route";

const state = vi.hoisted(
  (): {
    identity: { userId: string } | null;
    rpc: Mock<(name: string, args?: Record<string, unknown>) => { data: unknown; error: unknown }>;
  } => ({ identity: { userId: "user-a" }, rpc: vi.fn() }),
);

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
  getAuthState: () => Promise.resolve({ kind: state.identity ? "signed-in" : "signed-out" }),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

function post(body: unknown, origin = "https://madeora.example"): Promise<Response> {
  return POST(
    new Request("https://madeora.example/api/v1/me/security-review", {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: "madeora.example" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: null, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/me/security-review", () => {
  it("marks the security review as done with the person's own session", async () => {
    const response = await post({});
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("complete_security_review", undefined);
  });

  it("refuses a cross-site request, a signed-out caller and extra fields", async () => {
    expect((await post({}, "https://evil.example")).status).toBe(403);
    expect((await post({ done: true })).status).toBe(400);
    state.identity = null;
    expect((await post({})).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps a lost session to 401 and anything else to 500", async () => {
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "42501" } });
    expect((await post({})).status).toBe(401);
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "XX000" } });
    expect((await post({})).status).toBe(500);
  });
});
