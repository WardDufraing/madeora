import {
  PENDING_KEY,
  authorizeAfterGoogle,
  confirmedPath,
  openGoogleReauthSession,
  parseAccountChangeAction,
  startGoogleReauth,
  takePending,
} from "./google-reauth";

const reauth = {
  auth: { signInWithOAuth: vi.fn(), exchangeCodeForSession: vi.fn(), signOut: vi.fn() },
  rpc: vi.fn(),
};
const main = { auth: { getUser: vi.fn(), getSession: vi.fn() } };
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
