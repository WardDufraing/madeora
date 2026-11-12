import { hashChildSecret } from "./secret-hash";

const rpc = vi.fn();
const generateLink = vi.fn();
const verifyOtp = vi.fn();
const signOut = vi.fn();
const requestHeaders = new Headers({ "x-real-ip": "203.0.113.7" });

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc, auth: { admin: { generateLink } } }),
}));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(requestHeaders) }));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { verifyOtp, signOut } }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }),
}));

const DEVICE_HASH = "a".repeat(64);
const CHILD = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";
const ATTEMPT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const SESSION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0051";
const PIN = "2580";
const WRONG_PIN = "7391";

function accessToken(sessionId: string): string {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionId })).toString("base64url");
  return `header.${payload}.signature`;
}

let pinHash = "";
let logged: string[] = [];

beforeAll(async () => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", `sb_secret_${"x".repeat(32)}`);
  pinHash = await hashChildSecret(PIN);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
  rpc.mockReset();
  generateLink.mockReset();
  verifyOtp.mockReset();
  signOut.mockReset().mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function answerPinAttempt(outcome: string, extra: Record<string, unknown> = {}) {
  rpc.mockImplementation((name: string) => {
    if (name === "child_pin_attempt") {
      return Promise.resolve({
        data: [{ outcome, attempt_id: ATTEMPT, pin_hash: pinHash, locked_until: null, ...extra }],
        error: null,
      });
    }
    if (name === "child_sign_in_verified") {
      return Promise.resolve({
        data: [{ outcome: "verified", child_user_id: CHILD, alias_email: "alias@x.invalid" }],
        error: null,
      });
    }
    if (name === "child_sign_in_complete") {
      return Promise.resolve({
        data: [{ outcome: "registered", expires_at: "2026-11-12T16:00:00Z" }],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: { code: "XX000" } });
  });
}

/** Nothing the server sent or logged may contain the PIN or its hash (the step's done-condition). */
function expectNoSecretAnywhere(secret: string) {
  const sent = JSON.stringify([rpc.mock.calls, generateLink.mock.calls, verifyOtp.mock.calls]);
  expect(sent).not.toContain(secret);
  for (const line of logged) {
    expect(line).not.toContain(secret);
    expect(line).not.toContain(pinHash);
    expect(line).not.toContain("203.0.113.7");
  }
}

describe("child PIN sign-in (S42)", () => {
  it("issues and registers a session for the right PIN, never sending the PIN anywhere", async () => {
    const { signInChildWithPin } = await import("./service");
    answerPinAttempt("check");
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: "token-hash" } },
      error: null,
    });
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: accessToken(SESSION) } },
      error: null,
    });

    await expect(signInChildWithPin(DEVICE_HASH, CHILD, PIN)).resolves.toEqual({
      kind: "signed-in",
    });
    const attempt = rpc.mock.calls.find(([name]) => name === "child_pin_attempt");
    expect(attempt?.[1]).toMatchObject({
      p_device_hash: DEVICE_HASH,
      p_child_membership_id: CHILD,
    });
    // The client key is an HMAC, never the address.
    expect(attempt?.[1]).toHaveProperty("p_client_key", expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "token-hash" });
    expect(rpc).toHaveBeenCalledWith("child_sign_in_complete", {
      p_attempt_id: ATTEMPT,
      p_session_id: SESSION,
    });
    expectNoSecretAnywhere(PIN);
  });

  it("refuses a wrong PIN without issuing a session or logging it", async () => {
    const { signInChildWithPin } = await import("./service");
    answerPinAttempt("check");
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, WRONG_PIN)).resolves.toEqual({
      kind: "invalid",
    });
    expect(generateLink).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("child_sign_in_verified", expect.anything());
    expectNoSecretAnywhere(WRONG_PIN);
  });

  it("answers an unknown child exactly like a wrong PIN", async () => {
    const { signInChildWithPin } = await import("./service");
    answerPinAttempt("unknown", { pin_hash: null });
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, WRONG_PIN)).resolves.toEqual({
      kind: "invalid",
    });
  });

  it("passes on locks, throttles and unapproved devices", async () => {
    const { signInChildWithPin } = await import("./service");
    answerPinAttempt("locked", { locked_until: "infinity" });
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, PIN)).resolves.toEqual({
      kind: "locked",
      until: null,
    });
    answerPinAttempt("locked", { locked_until: "2026-11-12T12:15:00Z" });
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, PIN)).resolves.toEqual({
      kind: "locked",
      until: "2026-11-12T12:15:00Z",
    });
    answerPinAttempt("rate_limited");
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, PIN)).resolves.toEqual({
      kind: "rate-limited",
    });
    answerPinAttempt("device_not_approved");
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, PIN)).resolves.toEqual({
      kind: "device-not-approved",
    });
    expect(generateLink).not.toHaveBeenCalled();
  });

  it("ends the new session when it cannot be registered, and logs only an event and code", async () => {
    const { signInChildWithPin } = await import("./service");
    answerPinAttempt("check");
    rpc.mockImplementation((name: string) =>
      name === "child_sign_in_complete"
        ? Promise.resolve({ data: null, error: { code: "40001" } })
        : name === "child_pin_attempt"
          ? Promise.resolve({
              data: [{ outcome: "check", attempt_id: ATTEMPT, pin_hash: pinHash }],
              error: null,
            })
          : Promise.resolve({
              data: [{ outcome: "verified", child_user_id: CHILD, alias_email: "a@x.invalid" }],
              error: null,
            }),
    );
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: "token-hash" } },
      error: null,
    });
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: accessToken(SESSION) } },
      error: null,
    });
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, PIN)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(logged).toEqual([
      JSON.stringify({ event: "child_sign_in.register_failed", code: "40001" }),
    ]);
    expectNoSecretAnywhere(PIN);
  });

  it("says sign-in is off only after the right PIN", async () => {
    const { signInChildWithPin } = await import("./service");
    answerPinAttempt("check");
    rpc.mockImplementation((name: string) =>
      name === "child_pin_attempt"
        ? Promise.resolve({
            data: [{ outcome: "check", attempt_id: ATTEMPT, pin_hash: pinHash }],
            error: null,
          })
        : Promise.resolve({
            data: [{ outcome: "not_enabled", child_user_id: null, alias_email: null }],
            error: null,
          }),
    );
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, PIN)).resolves.toEqual({
      kind: "not-enabled",
    });
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, WRONG_PIN)).resolves.toEqual({
      kind: "invalid",
    });
    expect(generateLink).not.toHaveBeenCalled();
  });

  it("issues no session where the database's request check is not set up", async () => {
    const { signInChildWithPin } = await import("./service");
    rpc.mockImplementation((name: string) =>
      name === "child_pin_attempt"
        ? Promise.resolve({
            data: [{ outcome: "check", attempt_id: ATTEMPT, pin_hash: pinHash }],
            error: null,
          })
        : Promise.resolve({
            data: [{ outcome: "not_configured", child_user_id: null, alias_email: null }],
            error: null,
          }),
    );
    await expect(signInChildWithPin(DEVICE_HASH, CHILD, PIN)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(generateLink).not.toHaveBeenCalled();
    expectNoSecretAnywhere(PIN);
  });
});
