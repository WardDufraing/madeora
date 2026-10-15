import type { Mock } from "vitest";

import { PUT } from "./route";

type Role = "owner" | "administrator" | "member";
type Capability = "manageHomeSettings" | "manageInvitations" | "removeMembers";
interface State {
  identity: { userId: string } | null;
  context:
    | { status: "ok"; role: Role; granted: Capability[] }
    | { status: "not-found" }
    | { status: "unavailable" };
  directory:
    | { status: "ok"; members: { membershipId: string; role: Role; isSelf: boolean }[] }
    | { status: "not-found" }
    | { status: "unavailable" };
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "owner", granted: [] },
  directory: { status: "ok", members: [] },
  rpc: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const SELF = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const ADMIN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0012";
const OWNER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0013";

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
        membership: {
          homeId,
          role: state.context.role,
          grantedCapabilities: new Set(state.context.granted),
        },
      },
    });
  },
}));
vi.mock("@/members/directory", () => ({
  getHomeDirectory: () => Promise.resolve(state.directory),
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

/** The caller (`SELF`) with `role`, and one member of each other role. */
function setCaller(role: Role, granted: Capability[] = []): void {
  state.context = { status: "ok", role, granted };
  state.directory = {
    status: "ok",
    members: [
      { membershipId: SELF, role, isSelf: true },
      ...(role === "owner" ? [] : [{ membershipId: OWNER, role: "owner" as const, isSelf: false }]),
      { membershipId: MEMBER, role: "member", isSelf: false },
      { membershipId: ADMIN, role: "administrator", isSelf: false },
    ],
  };
}

function put(body: unknown, membershipId = ADMIN): Promise<Response> {
  return PUT(
    new Request(
      `https://madeora.example/api/v1/homes/${HOME_ID}/members/${membershipId}/capabilities`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...sameOrigin },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ homeId: HOME_ID, membershipId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  setCaller("owner");
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "ok", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PUT /api/v1/homes/{homeId}/members/{membershipId}/capabilities", () => {
  it("replaces an Administrator's capabilities and answers in a stable order", async () => {
    const response = await put({ capabilities: ["removeMembers", "manageHomeSettings"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      capabilities: ["manageHomeSettings", "removeMembers"],
    });
    expect(state.rpc).toHaveBeenCalledWith("set_administrator_capabilities", {
      p_home_id: HOME_ID,
      p_membership_id: ADMIN,
      p_capabilities: ["removeMembers", "manageHomeSettings"],
    });
  });

  it("revokes everything with an empty list", async () => {
    const response = await put({ capabilities: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ capabilities: [] });
  });

  it.each<[unknown, string]>([
    [{ capabilities: ["transferOwnership"] }, "an Owner-only power is not a capability"],
    [{ capabilities: ["removeMembers", "removeMembers"] }, "duplicates"],
    [{ capabilities: "removeMembers" }, "not a list"],
    [{}, "missing"],
  ])("refuses %j (%s)", async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses capabilities for a Member (only Administrators hold them)", async () => {
    expect((await put({ capabilities: ["removeMembers"] }, MEMBER)).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses an Administrator, even one holding every capability, and a Member", async () => {
    setCaller("administrator", ["manageHomeSettings", "manageInvitations", "removeMembers"]);
    expect((await put({ capabilities: [] })).status).toBe(403);
    setCaller("member");
    expect((await put({ capabilities: [] })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 409 stale when the target stopped being an Administrator meanwhile", async () => {
    state.rpc.mockReturnValue({ data: "stale", error: null });
    const response = await put({ capabilities: ["removeMembers"] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stale" });
  });

  it("answers 404 outside the Home", async () => {
    state.context = { status: "not-found" };
    expect((await put({ capabilities: [] })).status).toBe(404);
  });

  it("maps a malformed value the database refused to 400", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "22023" } });
    expect((await put({ capabilities: [] })).status).toBe(400);
  });
});
