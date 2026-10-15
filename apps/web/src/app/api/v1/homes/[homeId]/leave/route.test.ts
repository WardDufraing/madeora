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

function post(body: unknown = {}, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${HOME_ID}/leave`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId: HOME_ID }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  setCaller("member");
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "left", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/leave", () => {
  it.each<Role>(["member", "administrator"])("lets a %s leave", async (role) => {
    setCaller(role);
    const response = await post();
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("leave_home", { p_home_id: HOME_ID });
  });

  it("tells the Owner to transfer ownership first", async () => {
    setCaller("owner");
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "owner-must-transfer" });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps the database's own Owner refusal too", async () => {
    state.rpc.mockReturnValue({ data: "owner_must_transfer", error: null });
    expect((await post()).status).toBe(409);
  });

  it("answers 404 outside the Home", async () => {
    state.context = { status: "not-found" };
    expect((await post()).status).toBe(404);
  });

  it("refuses a body with fields and a cross-site request", async () => {
    expect((await post({ confirm: true })).status).toBe(400);
    expect((await post({}, { origin: "https://evil.example" })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
