import { pairingCodeOf, sha256Hex } from "./pairing-secret";
import { resumePairing } from "./service";

const rpc = vi.fn();
const generateLink = vi.fn();
const verifyOtp = vi.fn();
const signOut = vi.fn();
const service = vi.hoisted(() => ({ configured: true }));
const jar = new Map<string, string>();

vi.mock("@/child-sign-in/service", () => ({
  householdService: () => (service.configured ? { rpc, auth: { admin: { generateLink } } } : null),
  householdClientKey: () => Promise.resolve(service.configured ? "c".repeat(64) : null),
  sessionIdOf: (token: string) => (token === "token-1" ? SESSION : null),
}));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
      set: (name: string, value: string) => jar.set(name, value),
      delete: (name: string) => jar.delete(name),
    }),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { verifyOtp, signOut } }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const SESSION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0051";
const COOKIE = "madeora_display_pairing";
const SECRET = "A".repeat(43);
const EXPIRES = "2026-11-12T20:10:00Z";

let logged: string[] = [];

beforeEach(() => {
  service.configured = true;
  jar.clear();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  rpc.mockReset();
  generateLink.mockReset();
  verifyOtp.mockReset();
  signOut.mockReset().mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function answer(responses: Record<string, unknown[]>) {
  rpc.mockImplementation((name: string) => {
    const queue = responses[name];
    const next = queue?.shift();
    if (next === undefined) throw new Error(`unexpected rpc ${name}`);
    return Promise.resolve({ data: next, error: null });
  });
}

describe("resumePairing", () => {
  it("gives a tablet without a request a new code and keeps only its secret, in a cookie", async () => {
    answer({ display_pairing_start: [[{ outcome: "created", expires_at: EXPIRES }]] });
    const screen = await resumePairing(false, "Mozilla/5.0 (iPad)");

    const secret = jar.get(COOKIE) ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(screen).toEqual({ kind: "pending", code: pairingCodeOf(secret), expiresAt: EXPIRES });
    const [, args] = rpc.mock.calls[0] as [string, Record<string, string>];
    // Only hashes go to the database, never the secret or the code itself.
    expect(args["p_secret_hash"]).toBe(sha256Hex(secret));
    expect(JSON.stringify(args)).not.toContain(secret);
    expect(JSON.stringify(args)).not.toContain(pairingCodeOf(secret));
  });

  it("shows the same code again while the request is pending", async () => {
    jar.set(COOKIE, SECRET);
    answer({ display_pairing_status: [[{ status: "pending", expires_at: EXPIRES }]] });
    expect(await resumePairing(false, "")).toEqual({
      kind: "pending",
      code: pairingCodeOf(SECRET),
      expiresAt: EXPIRES,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("says expired rather than silently making a new code", async () => {
    jar.set(COOKIE, SECRET);
    answer({ display_pairing_status: [[{ status: "expired", expires_at: null }]] });
    expect(await resumePairing(false, "")).toEqual({ kind: "expired" });
  });

  it("throws the current code away when the tablet asks for a new one", async () => {
    jar.set(COOKIE, SECRET);
    answer({
      display_pairing_cancel: [true],
      display_pairing_start: [[{ outcome: "created", expires_at: EXPIRES }]],
    });
    const screen = await resumePairing(true, "");
    expect(rpc).toHaveBeenNthCalledWith(1, "display_pairing_cancel", {
      p_secret_hash: sha256Hex(SECRET),
    });
    expect(jar.get(COOKIE)).not.toBe(SECRET);
    expect(screen.kind).toBe("pending");
  });

  it("tries a new secret when the code collides with another tablet's", async () => {
    answer({
      display_pairing_start: [
        [{ outcome: "collision", expires_at: null }],
        [{ outcome: "created", expires_at: EXPIRES }],
      ],
    });
    expect((await resumePairing(false, "")).kind).toBe("pending");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("passes the throttle on", async () => {
    answer({ display_pairing_start: [[{ outcome: "rate_limited", expires_at: null }]] });
    expect(await resumePairing(false, "")).toEqual({ kind: "rate-limited" });
    expect(jar.has(COOKIE)).toBe(false);
  });

  it("turns an approval into the display's session and registers it", async () => {
    jar.set(COOKIE, SECRET);
    answer({
      display_pairing_status: [[{ status: "approved", expires_at: null }]],
      display_pairing_claim: [
        [{ outcome: "ready", alias_email: "display-x@displays.madeora.invalid" }],
      ],
      display_pairing_complete: ["registered"],
    });
    generateLink.mockResolvedValue({ data: { properties: { hashed_token: "th" } }, error: null });
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: "token-1" } },
      error: null,
    });

    expect(await resumePairing(false, "")).toEqual({ kind: "paired" });
    expect(generateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: "display-x@displays.madeora.invalid",
    });
    expect(rpc).toHaveBeenCalledWith("display_pairing_complete", {
      p_secret_hash: sha256Hex(SECRET),
      p_session_id: SESSION,
    });
    expect(jar.has(COOKIE)).toBe(false);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("ends a session the database would not register, and keeps the cookie for a retry", async () => {
    jar.set(COOKIE, SECRET);
    answer({
      display_pairing_status: [[{ status: "approved", expires_at: null }]],
      display_pairing_claim: [
        [{ outcome: "ready", alias_email: "display-x@displays.madeora.invalid" }],
      ],
      display_pairing_complete: ["invalid"],
    });
    generateLink.mockResolvedValue({ data: { properties: { hashed_token: "th" } }, error: null });
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "token-1" } }, error: null });

    expect(await resumePairing(false, "")).toEqual({ kind: "unavailable" });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(jar.get(COOKIE)).toBe(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain("display-x@");
  });

  it("is unavailable where the server has no Supabase secret key", async () => {
    service.configured = false;
    expect(await resumePairing(false, "")).toEqual({ kind: "unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
