import type { Mock } from "vitest";

import { PUT } from "./route";

type Role = "owner" | "administrator" | "member";
interface State {
  identity: { userId: string } | null;
  context: { status: "ok"; role: Role } | { status: "not-found" } | { status: "unavailable" };
  rpc: Mock<(name: string, args?: unknown) => Promise<{ data: unknown; error: unknown }>>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "member" },
  rpc: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const FILE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";

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
  createSupabaseServerClient: () => Promise.resolve({ rpc: state.rpc }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

function put(body: unknown, homeId = HOME_ID) {
  return PUT(
    new Request(`https://madeora.example/api/v1/homes/${homeId}/profile/avatar`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://madeora.example",
        host: "madeora.example",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "member" };
  state.rpc.mockReset().mockResolvedValue({ data: "ok", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PUT /api/v1/homes/{homeId}/profile/avatar", () => {
  it.each(["owner", "administrator", "member"] as const)(
    "lets a %s set their own picture in this Home",
    async (role) => {
      state.context = { status: "ok", role };
      const response = await put({ fileId: FILE_ID });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ avatarFileId: FILE_ID });
      expect(state.rpc).toHaveBeenCalledWith("set_my_home_avatar", {
        p_home_id: HOME_ID,
        p_file_id: FILE_ID,
      });
    },
  );

  it("goes back to the global picture with null", async () => {
    await put({ fileId: null });
    expect(state.rpc).toHaveBeenCalledWith("set_my_home_avatar", { p_home_id: HOME_ID });
  });

  it("answers a Home the caller is not in exactly like one that does not exist", async () => {
    state.context = { status: "not-found" };
    const response = await put({ fileId: FILE_ID });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not-found" });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 when the database refuses the file", async () => {
    state.rpc.mockResolvedValue({ data: "not_found", error: null });
    expect((await put({ fileId: FILE_ID })).status).toBe(404);
  });

  it("cannot be pointed at another member", async () => {
    expect((await put({ fileId: FILE_ID, userId: "user-b" })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 500 when the Home cannot be loaded", async () => {
    state.context = { status: "unavailable" };
    expect((await put({ fileId: FILE_ID })).status).toBe(500);
  });
});
