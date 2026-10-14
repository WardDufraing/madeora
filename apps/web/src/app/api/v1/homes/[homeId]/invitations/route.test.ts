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
const REQUEST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0003";
const TOKEN = "a".repeat(43);

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

function post(body: unknown, headers: Record<string, string> = {}, homeId = HOME_ID) {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${homeId}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId }) },
  );
}

function created(outcome: string, extra: Record<string, unknown> = {}) {
  return {
    data: [
      {
        outcome,
        invitation_id: outcome === "created" || outcome === "existing" ? INVITATION_ID : null,
        token: outcome === "created" || outcome === "existing" ? TOKEN : null,
        expires_at: "2026-10-21T10:00:00+00:00",
        delivery_status: "pending",
        ...extra,
      },
    ],
    error: null,
  };
}

async function invitationOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as { invitation: Record<string, unknown> }).invitation;
}

const emailBody = {
  kind: "email",
  role: "member",
  email: "Someone@Example.com",
  language: "nl",
  requestId: REQUEST_ID,
};
const linkBody = {
  kind: "link",
  role: "member",
  expiresIn: "24h",
  maxUses: 3,
  requestId: REQUEST_ID,
};
const codeBody = { kind: "join_code", expiresIn: "30d", requestId: REQUEST_ID };

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "owner" };
  state.rpc.mockReset();
  state.rpc.mockImplementation((name) =>
    name === "create_home_invitation" ? created("created") : { data: "ok", error: null },
  );
  state.send.mockReset();
  state.send.mockResolvedValue("sent");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/invitations", () => {
  it("creates an email invitation, sends it once with a stable key and records the delivery", async () => {
    const response = await post(emailBody);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      invitation: {
        id: INVITATION_ID,
        kind: "email",
        expiresAt: "2026-10-21T10:00:00+00:00",
        url: null,
        code: null,
        delivery: "sent",
      },
    });
    expect(state.rpc).toHaveBeenCalledWith("create_home_invitation", {
      p_home_id: HOME_ID,
      p_kind: "email",
      p_role: "member",
      p_request_id: REQUEST_ID,
      p_recipient_email: "someone@example.com",
      p_email_locale: "nl",
      p_max_admissions: 1,
    });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "nl",
        homeName: "Thuis",
        role: "member",
        recipientEmail: "someone@example.com",
        url: `https://madeora.example/join/${TOKEN}`,
        timeZone: "Europe/Brussels",
      }),
      `invitation-${INVITATION_ID}-first`,
    );
    expect(state.rpc).toHaveBeenCalledWith("record_home_invitation_delivery", {
      p_home_id: HOME_ID,
      p_invitation_id: INVITATION_ID,
      p_status: "sent",
    });
  });

  it("gives the same answer shape for any address: nothing looks up accounts", async () => {
    const first: unknown = await (await post({ ...emailBody, email: "known@example.com" })).json();
    const second: unknown = await (
      await post({ ...emailBody, email: "unknown@example.com" })
    ).json();
    expect(first).toEqual(second);
    const names = state.rpc.mock.calls.map(([name]) => name);
    expect(new Set(names)).toEqual(
      new Set(["create_home_invitation", "record_home_invitation_delivery"]),
    );
  });

  it("does not send again when a retry finds the email already sent", async () => {
    state.rpc.mockImplementation((name) =>
      name === "create_home_invitation"
        ? created("existing", { delivery_status: "sent" })
        : { data: "ok", error: null },
    );
    const response = await post(emailBody);
    expect(response.status).toBe(200);
    expect((await invitationOf(response)).delivery).toBe("sent");
    expect(state.send).not.toHaveBeenCalled();
  });

  it("sends again with the same key when a retry finds the first send failed", async () => {
    state.rpc.mockImplementation((name) =>
      name === "create_home_invitation"
        ? created("existing", { delivery_status: "failed" })
        : { data: "ok", error: null },
    );
    await post(emailBody);
    expect(state.send).toHaveBeenCalledWith(expect.anything(), `invitation-${INVITATION_ID}-first`);
  });

  it.each(["failed", "not_configured"])(
    "reports a %s delivery instead of hiding it",
    async (status) => {
      state.send.mockResolvedValue(status);
      const response = await post(emailBody);
      expect(response.status).toBe(201);
      expect((await invitationOf(response)).delivery).toBe(status);
      expect(state.rpc).toHaveBeenCalledWith(
        "record_home_invitation_delivery",
        expect.objectContaining({ p_status: status }),
      );
    },
  );

  it("creates a multi-use link and returns its address, never sending email", async () => {
    const response = await post(linkBody);
    expect(response.status).toBe(201);
    expect(await invitationOf(response)).toMatchObject({
      kind: "link",
      url: `https://madeora.example/join/${TOKEN}`,
      code: null,
      delivery: null,
    });
    expect(state.rpc).toHaveBeenCalledWith("create_home_invitation", {
      p_home_id: HOME_ID,
      p_kind: "link",
      p_role: "member",
      p_request_id: REQUEST_ID,
      p_expires_in: "24h",
      p_max_admissions: 3,
    });
    expect(state.send).not.toHaveBeenCalled();
  });

  it("creates a join code for Members only, formatted for reading", async () => {
    state.rpc.mockImplementation(() => ({
      data: [
        {
          outcome: "created",
          invitation_id: INVITATION_ID,
          token: "ABCDE12345",
          expires_at: "2026-11-13T10:00:00+00:00",
          delivery_status: null,
        },
      ],
      error: null,
    }));
    const response = await post(codeBody);
    expect(await invitationOf(response)).toMatchObject({
      kind: "join_code",
      code: "ABCDE-12345",
      url: "https://madeora.example/join/ABCDE12345",
    });
    expect(state.rpc).toHaveBeenCalledWith(
      "create_home_invitation",
      expect.objectContaining({ p_kind: "join_code", p_role: "member", p_expires_in: "30d" }),
    );
  });

  it("refuses an Administrator join code", async () => {
    expect((await post({ ...codeBody, role: "administrator" })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each<Role>(["administrator", "member"])(
    "refuses a %s without the capability, before the database",
    async (role) => {
      state.context = { status: "ok", role };
      const response = await post(linkBody);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "not-permitted" });
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("lets only the Owner invite an Administrator", async () => {
    expect((await post({ ...linkBody, role: "administrator" })).status).toBe(201);
    state.context = { status: "ok", role: "administrator" };
    state.rpc.mockClear();
    expect((await post({ ...linkBody, role: "administrator" })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for a Home the person does not belong to, as for one that does not exist", async () => {
    state.context = { status: "not-found" };
    expect((await post(linkBody)).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 500 when the membership cannot be read", async () => {
    state.context = { status: "unavailable" };
    expect((await post(linkBody)).status).toBe(500);
  });

  it.each([
    ["limit_reached", 409, "limit-reached"],
    ["duplicate_email", 409, "duplicate-email"],
    ["rate_limited", 429, "rate-limited"],
    ["not_permitted", 403, "not-permitted"],
    ["not_found", 404, "not-found"],
  ])("maps the database outcome %s", async (outcome, status, error) => {
    state.rpc.mockImplementation(() => created(outcome));
    const response = await post(emailBody);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(state.send).not.toHaveBeenCalled();
  });

  it.each([
    ["22023", 400],
    ["42501", 401],
    ["XX000", 500],
  ])("maps database error %s to %i", async (code, status) => {
    state.rpc.mockImplementation(() => ({ data: null, error: { code, message: "secret detail" } }));
    expect((await post(linkBody)).status).toBe(status);
  });

  it("logs a database failure by code only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.rpc.mockImplementation(() => ({ data: null, error: { code: "XX000", message: "x" } }));
    await post(emailBody);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("XX000");
    expect(logged).not.toContain("example.com");
  });

  it("refuses a cross-site request (CSRF)", async () => {
    expect((await post(linkBody, { origin: "https://evil.example" })).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses another content type", async () => {
    expect((await post(linkBody, { "content-type": "text/plain" })).status).toBe(415);
  });

  it("refuses an oversized body", async () => {
    expect((await post({ ...linkBody, padding: "x".repeat(5000) })).status).toBe(413);
  });

  it("refuses a signed-out request", async () => {
    state.identity = null;
    expect((await post(linkBody)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown kind", { ...linkBody, kind: "sms" }],
    ["a cap above 10", { ...linkBody, maxUses: 11 }],
    ["an unknown expiry", { ...linkBody, expiresIn: "1y" }],
    ["an Owner role", { ...linkBody, role: "owner" }],
    ["a malformed email", { ...emailBody, email: "not-an-email" }],
    ["a missing request id", { kind: "link", role: "member", expiresIn: "7d", maxUses: 1 }],
    ["extra fields", { ...linkBody, homeId: HOME_ID }],
    ["not JSON", "{"],
  ])("refuses %s", async (_, body) => {
    expect((await post(body)).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
