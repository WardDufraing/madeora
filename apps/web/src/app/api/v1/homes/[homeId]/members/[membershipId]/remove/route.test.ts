import type { Mock } from "vitest";

import { POST } from "./route";

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

function post(body: unknown, membershipId = MEMBER): Promise<Response> {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${HOME_ID}/members/${membershipId}/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId: HOME_ID, membershipId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  setCaller("owner");
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "removed", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/members/{membershipId}/remove", () => {
  it("lets the Owner remove a Member, with the role they confirmed", async () => {
    const response = await post({ expectedRole: "member" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(state.rpc).toHaveBeenCalledWith("remove_home_member", {
      p_home_id: HOME_ID,
      p_membership_id: MEMBER,
      p_expected_role: "member",
    });
  });

  it("lets the Owner remove an Administrator", async () => {
    expect((await post({ expectedRole: "administrator" }, ADMIN)).status).toBe(200);
  });

  it("lets an Administrator with removeMembers remove a Member, never an Administrator", async () => {
    setCaller("administrator", ["removeMembers"]);
    expect((await post({ expectedRole: "member" })).status).toBe(200);
    expect((await post({ expectedRole: "administrator" }, ADMIN)).status).toBe(403);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses an Administrator without removeMembers, and a Member", async () => {
    setCaller("administrator", ["manageHomeSettings", "manageInvitations"]);
    expect((await post({ expectedRole: "member" })).status).toBe(403);
    setCaller("member");
    expect((await post({ expectedRole: "member" })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("never removes the Owner, and nobody removes themselves", async () => {
    setCaller("administrator", ["removeMembers"]);
    expect((await post({ expectedRole: "owner" }, OWNER)).status).toBe(403);
    setCaller("owner");
    expect((await post({ expectedRole: "owner" }, SELF)).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("reports someone who is already gone as not found", async () => {
    const response = await post({ expectedRole: "member" }, "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0099");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not-found" });
  });

  it.each([
    ["stale", 409, "stale"],
    ["not_found", 404, "not-found"],
    ["not_permitted", 403, "not-permitted"],
  ])("maps the database outcome %s", async (outcome, status, error) => {
    state.rpc.mockReturnValue({ data: outcome, error: null });
    const response = await post({ expectedRole: "member" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("refuses a missing or unknown expected role", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ expectedRole: "guest" })).status).toBe(400);
  });

  it("refuses a signed-out caller", async () => {
    state.identity = null;
    expect((await post({ expectedRole: "member" })).status).toBe(401);
  });
});
