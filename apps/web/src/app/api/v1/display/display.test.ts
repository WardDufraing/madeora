import { POST as heartbeat } from "./heartbeat/route";
import { POST as pairing } from "./pairing/route";
import { POST as reset } from "./reset/route";

interface State {
  kind: string;
  session: { kind: string };
  screen: Readonly<Record<string, string>>;
}
const state = vi.hoisted((): State => ({
  kind: "signed-out",
  session: { kind: "ok" },
  screen: { kind: "pending", code: "ABCDEFGH", expiresAt: "2026-11-12T20:10:00Z" },
}));
const resumePairing = vi.fn();
const signOut = vi.fn();

vi.mock("@/auth/identity", () => ({
  getAuthState: () => Promise.resolve({ kind: state.kind }),
}));
vi.mock("@/displays/service", () => ({
  resumePairing: (renew: boolean, userAgent: string) => {
    resumePairing(renew, userAgent);
    return Promise.resolve(state.screen);
  },
}));
vi.mock("@/displays/server", () => ({
  getDisplaySession: () =>
    Promise.resolve(
      state.session.kind === "ok"
        ? {
            kind: "ok",
            session: {
              displayId: "d",
              displayName: "Keuken",
              homeName: "Thuis",
              homeTimezone: "Europe/Brussels",
            },
          }
        : state.session,
    ),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { signOut } }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = {
  origin: "https://madeora.example",
  host: "madeora.example",
  "content-type": "application/json",
};

function post(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  headers: Record<string, string> = sameOrigin,
) {
  return handler(
    new Request(`https://madeora.example/api/v1/display/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.kind = "signed-out";
  state.session = { kind: "ok" };
  state.screen = { kind: "pending", code: "ABCDEFGH", expiresAt: "2026-11-12T20:10:00Z" };
  resumePairing.mockReset();
  signOut.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/v1/display/pairing", () => {
  it("gives a browser without a session its code", async () => {
    const response = await post(
      pairing,
      "pairing",
      { renew: false },
      {
        ...sameOrigin,
        "user-agent": "Mozilla/5.0 (iPad)",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "pending",
      code: "ABCDEFGH",
      expiresAt: "2026-11-12T20:10:00Z",
    });
    expect(resumePairing).toHaveBeenCalledWith(false, "Mozilla/5.0 (iPad)");
  });

  it.each(["signed-in", "child", "display", "second-factor"])(
    "never pairs over an existing %s session",
    async (kind) => {
      state.kind = kind;
      const response = await post(pairing, "pairing", { renew: false });
      expect(response.status).toBe(409);
      expect(resumePairing).not.toHaveBeenCalled();
    },
  );

  it("refuses cross-site requests and unknown fields", async () => {
    expect(
      (
        await post(
          pairing,
          "pairing",
          { renew: false },
          {
            ...sameOrigin,
            origin: "https://evil.example",
          },
        )
      ).status,
    ).toBe(403);
    expect((await post(pairing, "pairing", { renew: false, homeId: "x" })).status).toBe(400);
    expect(resumePairing).not.toHaveBeenCalled();
  });

  it("passes on the throttle", async () => {
    state.screen = { kind: "rate-limited" };
    expect((await post(pairing, "pairing", { renew: true })).status).toBe(429);
  });
});

describe("POST /api/v1/display/heartbeat", () => {
  it("answers a working display with its names only", async () => {
    state.kind = "display";
    const response = await post(heartbeat, "heartbeat", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      displayName: "Keuken",
      homeName: "Thuis",
      homeTimezone: "Europe/Brussels",
    });
  });

  it("answers 401 for a refused display and for anyone who is not a display", async () => {
    state.kind = "display";
    state.session = { kind: "refused" };
    expect((await post(heartbeat, "heartbeat", {})).status).toBe(401);
    state.kind = "signed-in";
    state.session = { kind: "ok" };
    expect((await post(heartbeat, "heartbeat", {})).status).toBe(401);
  });
});

describe("POST /api/v1/display/reset", () => {
  it("signs out only a display session the database refuses", async () => {
    state.kind = "display";
    state.session = { kind: "refused" };
    expect((await post(reset, "reset", {})).status).toBe(200);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("never signs a working display out", async () => {
    state.kind = "display";
    expect((await post(reset, "reset", {})).status).toBe(409);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("does nothing for a member's session", async () => {
    state.kind = "signed-in";
    expect((await post(reset, "reset", {})).status).toBe(200);
    expect(signOut).not.toHaveBeenCalled();
  });
});
