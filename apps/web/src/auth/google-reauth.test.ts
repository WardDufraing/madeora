import {
  PENDING_KEY,
  authorizeAfterGoogle,
  confirmedPath,
  isReturnPath,
  openGoogleReauthSession,
  parseAccountChangeAction,
  startGoogleReauth,
  takePending,
  verifyReauthCode,
  browserSessionIsAal2,
} from "./google-reauth";

const mfa = () => ({ listFactors: vi.fn(), challengeAndVerify: vi.fn() });
const reauth = {
  auth: {
    signInWithOAuth: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    signOut: vi.fn(),
    mfa: mfa(),
  },
  rpc: vi.fn(),
};
const main = { auth: { getUser: vi.fn(), getSession: vi.fn(), mfa: mfa() } };
vi.mock("./supabase-browser", () => ({
  getGoogleReauthClient: () => reauth,
  getSupabaseBrowserClient: () => main,
}));

const pending = { action: "email", userId: "user-a", twoFactor: false } as const;

function tokenFor(sessionId: string): string {
  return `h.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString("base64url")}.s`;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.sessionStorage.clear();
  reauth.auth.signOut.mockResolvedValue({ error: null });
  reauth.auth.signInWithOAuth.mockResolvedValue({ error: null });
  reauth.rpc.mockResolvedValue({ data: "2026-11-06T10:02:00Z", error: null });
  main.auth.getSession.mockResolvedValue({
    data: { session: { access_token: tokenFor("main-session") } },
  });
});

describe("google reauthentication", () => {
  it("tells a trusted browser's aal1 session from one that passed two-factor sign-in", async () => {
    const token = (aal: string) =>
      `h.${Buffer.from(JSON.stringify({ session_id: "s", aal })).toString("base64url")}.s`;
    main.auth.getSession.mockResolvedValue({ data: { session: { access_token: token("aal2") } } });
    expect(await browserSessionIsAal2()).toBe(true);
    main.auth.getSession.mockResolvedValue({ data: { session: { access_token: token("aal1") } } });
    expect(await browserSessionIsAal2()).toBe(false);
    main.auth.getSession.mockResolvedValue({ data: { session: null } });
    expect(await browserSessionIsAal2()).toBe(false);
  });

  it("verifies the code on the session it is told to, and only there", async () => {
    for (const client of [main, reauth]) {
      client.auth.mfa.listFactors.mockResolvedValue({
        data: { totp: [{ id: "f-1" }] },
        error: null,
      });
      client.auth.mfa.challengeAndVerify.mockResolvedValue({ error: null });
    }
    expect(await verifyReauthCode("google", "123456")).toEqual({ error: null, noFactor: false });
    expect(reauth.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: "f-1",
      code: "123456",
    });
    expect(main.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();

    expect(await verifyReauthCode("browser", "654321")).toEqual({ error: null, noFactor: false });
    expect(main.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: "f-1",
      code: "654321",
    });

    main.auth.mfa.listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    expect(await verifyReauthCode("browser", "111111")).toEqual({ error: null, noFactor: true });
  });

  it("knows only the database's account-change permissions", () => {
    expect(parseAccountChangeAction("backup_email")).toBe("backup_email");
    expect(parseAccountChangeAction("admin")).toBeNull();
    expect(parseAccountChangeAction(undefined)).toBeNull();
    expect(confirmedPath("two_factor_disable")).toBe(
      "/settings/security?confirmed=two_factor_disable#two-factor",
    );
  });

  it("remembers what was started in this tab, once", async () => {
    await startGoogleReauth(pending, "ada@example.test");
    expect(reauth.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "http://localhost:3000/auth/reauthenticate",
        queryParams: { prompt: "select_account", login_hint: "ada@example.test" },
      },
    });
    expect(takePending()).toEqual(pending);
    expect(takePending()).toBeNull();
  });

  it("ignores a tampered pending entry", () => {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...pending, action: "admin" }));
    expect(takePending()).toBeNull();
  });

  it("refuses a Google sign-in of another account and ends it", async () => {
    reauth.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: "user-b" } },
      error: null,
    });
    main.auth.getUser.mockResolvedValue({ data: { user: { id: "user-a" } } });
    expect(await openGoogleReauthSession(pending, "code-1")).toBe("otherAccount");
    expect(reauth.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("treats a missing code as cancelled", async () => {
    expect(await openGoogleReauthSession(pending, null)).toBe("cancelled");
    expect(reauth.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("binds the permission to the browser's own session and always ends the Google session", async () => {
    expect(await authorizeAfterGoogle("email")).toBe(true);
    expect(reauth.rpc).toHaveBeenCalledWith("authorize_account_change", {
      p_action: "email",
      p_session_id: "main-session",
    });
    expect(reauth.auth.signOut).toHaveBeenCalledWith({ scope: "local" });

    reauth.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect(await authorizeAfterGoogle("email")).toBe(false);
    expect(reauth.auth.signOut).toHaveBeenCalledTimes(2);
  });
});

describe("return path after confirming", () => {
  const home = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";

  it("returns a data export to its Home's export page only", () => {
    expect(confirmedPath("data_export", `/homes/${home}/export`)).toBe(
      `/homes/${home}/export?confirmed=data_export`,
    );
    expect(confirmedPath("data_export")).toBe("/settings/privacy/export?confirmed=data_export");
    // Another action never follows a return path.
    expect(confirmedPath("security_report", `/homes/${home}/export`)).toBe(
      "/settings/security/activity?confirmed=security_report#report",
    );
  });

  it("refuses anything that could lead elsewhere", () => {
    for (const path of [
      "https://evil.test/homes/x/export",
      "//evil.test",
      `/homes/${home}/export/../../settings`,
      `/homes/${home}/export?next=//evil.test`,
      `/homes/${home.toUpperCase()}/export`,
      "/homes/not-a-uuid/export",
      `/homes/${home}/tasks`,
      42,
    ]) {
      expect(isReturnPath(path)).toBe(false);
    }
    expect(confirmedPath("data_export", "//evil.test")).toBe(
      "/settings/privacy/export?confirmed=data_export",
    );
  });
});
