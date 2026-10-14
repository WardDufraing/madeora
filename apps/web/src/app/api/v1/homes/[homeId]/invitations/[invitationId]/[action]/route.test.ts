import type { Mock } from "vitest";

import { POST } from "./route";

type Role = "owner" | "administrator" | "member";
interface State {
  identity: { userId: string } | null;
  context: { status: "ok"; role: Role } | { status: "not-found" } | { status: "unavailable" };
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
  send: Mock<(props: Record<string, unknown>, key: string) => Promise<string>>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "owner" },
  rpc: vi.fn(),
  send: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const INVITATION_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const NEW_TOKEN = "b".repeat(43);

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
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@/email/send", () => ({
  sendHomeInvitationEmail: (props: Record<string, unknown>, key: string) => state.send(props, key),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function post(
  action: string,
  body: unknown = {},
  headers: Record<string, string> = {},
  invitationId = INVITATION_ID,
) {
  return POST(
    new Request(
      `https://madeora.example/api/v1/homes/${HOME_ID}/invitations/${invitationId}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin, ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ homeId: HOME_ID, invitationId, action }) },
  );
}

function emailRow(outcome = "ok") {
  return {
    data: [
      outcome === "ok"
        ? {
            outcome,
            token: NEW_TOKEN,
            recipient_email: "someone@example.com",
            email_locale: "en",
            role: "member",
            expires_at: "2026-10-21T10:00:00+00:00",
            home_name: "Thuis",
          }
        : {
            outcome,
            token: null,
            recipient_email: null,
            email_locale: null,
            role: null,
            expires_at: null,
            home_name: null,
          },
    ],
    error: null,
  };
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "owner" };
  state.rpc.mockReset();
  state.rpc.mockImplementation((name) => {
    if (name === "revoke_home_invitation") return { data: "revoked", error: null };
    if (name === "record_home_invitation_delivery") return { data: "ok", error: null };
    return emailRow();
  });
  state.send.mockReset();
  state.send.mockResolvedValue("sent");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/invitations/{id}/{action}", () => {
  it("revokes an invitation of exactly this Home", async () => {
    const response = await post("revoke");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(state.rpc).toHaveBeenCalledWith("revoke_home_invitation", {
      p_home_id: HOME_ID,
      p_invitation_id: INVITATION_ID,
    });
    expect(state.send).not.toHaveBeenCalled();
  });

  it.each([
    ["not_active", 409, "not-active"],
    ["not_found", 404, "not-found"],
    ["not_permitted", 403, "not-permitted"],
  ])("maps a revoke outcome %s", async (outcome, status, error) => {
    state.rpc.mockImplementation(() => ({ data: outcome, error: null }));
    const response = await post("revoke");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it.each(["resend", "renew"])(
    "%s sends the email with the link from the database",
    async (action) => {
      const response = await post(action);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        delivery: "sent",
        expiresAt: "2026-10-21T10:00:00+00:00",
      });
      expect(state.rpc).toHaveBeenCalledWith(`${action}_home_invitation`, {
        p_home_id: HOME_ID,
        p_invitation_id: INVITATION_ID,
      });
      expect(state.send).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `https://madeora.example/join/${NEW_TOKEN}`,
          recipientEmail: "someone@example.com",
          locale: "en",
        }),
        expect.stringMatching(new RegExp(`^invitation-${INVITATION_ID}-${action}-`)),
      );
      expect(state.rpc).toHaveBeenCalledWith("record_home_invitation_delivery", {
        p_home_id: HOME_ID,
        p_invitation_id: INVITATION_ID,
        p_status: "sent",
      });
    },
  );

  it("uses a new idempotency key for every resend", async () => {
    await post("resend");
    await post("resend");
    const [first, second] = state.send.mock.calls.map(([, key]) => key);
    expect(first).not.toBe(second);
  });

  it("reports a failed send", async () => {
    state.send.mockResolvedValue("failed");
    expect(await (await post("resend")).json()).toMatchObject({ delivery: "failed" });
  });

  it.each([
    ["rate_limited", 429, "rate-limited"],
    ["has_request", 409, "has-request"],
    ["not_email", 409, "not-active"],
    ["not_active", 409, "not-active"],
  ])("maps a resend outcome %s without sending", async (outcome, status, error) => {
    state.rpc.mockImplementation(() => emailRow(outcome));
    const response = await post("resend");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(state.send).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown action", async () => {
    expect((await post("delete")).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed invitation id", async () => {
    expect((await post("revoke", {}, {}, "not-a-uuid")).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each<Role>(["administrator", "member"])(
    "refuses a %s without the capability",
    async (role) => {
      state.context = { status: "ok", role };
      expect((await post("revoke")).status).toBe(403);
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for a Home the person does not belong to", async () => {
    state.context = { status: "not-found" };
    expect((await post("renew")).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a body with fields", async () => {
    expect((await post("revoke", { reason: "x" })).status).toBe(400);
  });

  it("refuses a cross-site request (CSRF)", async () => {
    expect((await post("revoke", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    state.identity = null;
    expect((await post("resend")).status).toBe(401);
    expect(state.send).not.toHaveBeenCalled();
  });
});
