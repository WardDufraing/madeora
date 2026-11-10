import type { Mock } from "vitest";

import { POST } from "./route";

const state = vi.hoisted(
  (): {
    identity: { userId: string } | null;
    rpc: Mock<(name: string, args?: Record<string, unknown>) => { data: unknown; error: unknown }>;
    deleted: string[];
  } => ({ identity: { userId: "user-a" }, rpc: vi.fn(), deleted: [] }),
);

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
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
      getAll: () => [
        { name: "sb-proj-auth-token" },
        { name: "sb-proj-auth-token.1" },
        { name: "theme" },
      ],
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
    new Request("https://madeora.example/api/v1/me/delete-account", {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: "madeora.example" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.deleted = [];
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "2026-12-10T09:00:00+00:00", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/me/delete-account", () => {
  it.each(["DELETE", "VERWIJDER"])(
    "asks for the deletion with %s and drops this browser's session",
    async (confirmation) => {
      const response = await post({ confirmation });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ purgeAfter: "2026-12-10T09:00:00+00:00" });
      expect(state.rpc).toHaveBeenCalledWith("request_account_deletion", undefined);
      expect(state.deleted).toEqual(["sb-proj-auth-token", "sb-proj-auth-token.1"]);
    },
  );

  it("refuses without the exact word, cross-site, or signed out", async () => {
    expect((await post({ confirmation: "delete" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ confirmation: "DELETE" }, "https://evil.example")).status).toBe(403);
    state.identity = null;
    expect((await post({ confirmation: "DELETE" })).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("keeps the session when the database refuses", async () => {
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "P0001", hint: "sole_owner" } });
    expect((await post({ confirmation: "DELETE" })).status).toBe(409);
    state.rpc.mockReturnValueOnce({
      data: null,
      error: { code: "42501", hint: "reauthentication_required" },
    });
    expect((await post({ confirmation: "DELETE" })).status).toBe(403);
    expect(state.deleted).toEqual([]);
  });
});
