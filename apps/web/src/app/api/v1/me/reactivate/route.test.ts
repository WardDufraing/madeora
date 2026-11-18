import type { Mock } from "vitest";

import { POST } from "./route";

const state = vi.hoisted(
  (): {
    kind: string;
    rpc: Mock<(name: string, args?: Record<string, unknown>) => { data: unknown; error: unknown }>;
    deleted: string[];
  } => ({ kind: "deactivated", rpc: vi.fn(), deleted: [] }),
);

vi.mock("@/auth/identity", () => ({
  // A deactivated account's session has no verified identity: only the auth state names it.
  getVerifiedIdentity: () =>
    Promise.resolve(state.kind === "signed-in" ? { userId: "user-a" } : null),
  getAuthState: () => Promise.resolve({ kind: state.kind }),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      getAll: () => [{ name: "sb-proj-auth-token" }, { name: "md-locale" }],
      delete: (name: string) => {
        state.deleted.push(name);
      },
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

function post(body: unknown, origin = "https://madeora.example"): Promise<Response> {
  return POST(
    new Request("https://madeora.example/api/v1/me/reactivate", {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: "madeora.example" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.kind = "deactivated";
  state.deleted = [];
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "2026-11-01T20:30:00+00:00", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/me/reactivate", () => {
  it("reactivates from the deactivated account's own session, then drops its cookies", async () => {
    const response = await post({});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ since: "2026-11-01T20:30:00+00:00" });
    expect(state.rpc).toHaveBeenCalledWith("reactivate_my_account", undefined);
    expect(state.deleted).toEqual(["sb-proj-auth-token"]);
  });

  it.each(["signed-in", "signed-out", "second-factor", "child", "display"])(
    "refuses a %s session: only a deactivated account reactivates",
    async (kind) => {
      state.kind = kind;
      expect((await post({})).status).toBe(401);
      expect(state.rpc).not.toHaveBeenCalled();
      expect(state.deleted).toEqual([]);
    },
  );

  it("refuses a cross-site request and extra fields", async () => {
    expect((await post({}, "https://evil.example")).status).toBe(403);
    expect((await post({ userId: "user-b" })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("keeps the cookies when the database refuses", async () => {
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "42501" } });
    expect((await post({})).status).toBe(401);
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "XX000" } });
    expect((await post({})).status).toBe(500);
    expect(state.deleted).toEqual([]);
  });
});
