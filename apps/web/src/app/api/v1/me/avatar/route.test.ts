import type { Mock } from "vitest";

import { PUT } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args?: unknown) => Promise<{ data: unknown; error: unknown }>>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc: state.rpc }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const FILE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";

function put(body: unknown) {
  return PUT(
    new Request("https://madeora.example/api/v1/me/avatar", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://madeora.example",
        host: "madeora.example",
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset().mockResolvedValue({ data: "ok", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PUT /api/v1/me/avatar", () => {
  it("sets a ready file of the caller's own as their global avatar", async () => {
    const response = await put({ fileId: FILE_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ avatarFileId: FILE_ID });
    expect(state.rpc).toHaveBeenCalledWith("set_my_avatar", { p_file_id: FILE_ID });
  });

  it("removes the avatar with null", async () => {
    const response = await put({ fileId: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ avatarFileId: null });
    expect(state.rpc).toHaveBeenCalledWith("set_my_avatar", {});
  });

  it("answers 404 for a file that is not the caller's ready avatar", async () => {
    state.rpc.mockResolvedValue({ data: "not_found", error: null });
    expect((await put({ fileId: FILE_ID })).status).toBe(404);
  });

  it("cannot target another person and refuses a malformed id", async () => {
    expect((await put({ fileId: FILE_ID, userId: "user-b" })).status).toBe(400);
    expect((await put({ fileId: "u/abc" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    state.identity = null;
    expect((await put({ fileId: FILE_ID })).status).toBe(401);
  });
});
