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

const REQUEST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const TRANSFER_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${HOME_ID}/ownership-transfers`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId: HOME_ID }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  setCaller("owner");
  state.rpc.mockReset();
  state.rpc.mockReturnValue({
    data: [{ outcome: "started", transfer_id: TRANSFER_ID }],
    error: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/ownership-transfers", () => {
  it.each([MEMBER, ADMIN])("lets the Owner nominate an existing member (%s)", async (target) => {
    const response = await post({ membershipId: target, requestId: REQUEST_ID });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ transfer: { id: TRANSFER_ID } });
    expect(state.rpc).toHaveBeenCalledWith("start_ownership_transfer", {
      p_home_id: HOME_ID,
      p_membership_id: target,
      p_request_id: REQUEST_ID,
    });
  });

  it("refuses nominating themselves or someone outside the Home", async () => {
    expect((await post({ membershipId: SELF, requestId: REQUEST_ID })).status).toBe(403);
    expect(
      (await post({ membershipId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0099", requestId: REQUEST_ID }))
        .status,
    ).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses an Administrator, whatever they hold", async () => {
    setCaller("administrator", ["manageHomeSettings", "manageInvitations", "removeMembers"]);
    expect((await post({ membershipId: MEMBER, requestId: REQUEST_ID })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 409 when a transfer is already pending", async () => {
    state.rpc.mockReturnValue({
      data: [{ outcome: "pending_exists", transfer_id: null }],
      error: null,
    });
    const response = await post({ membershipId: MEMBER, requestId: REQUEST_ID });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "pending-exists" });
  });

  it("requires a request id", async () => {
    expect((await post({ membershipId: MEMBER })).status).toBe(400);
  });
});
