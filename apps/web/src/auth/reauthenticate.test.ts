import { AuthApiError } from "@supabase/supabase-js";

import { reauthenticate } from "./reauthenticate";

// The extra, memory-only session of the password sign-in.
const client = {
  auth: {
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    mfa: { listFactors: vi.fn(), challengeAndVerify: vi.fn() },
  },
  rpc: vi.fn(),
};
const getSession = vi.fn();
// The browser's own session: aal2 normally, aal1 on a trusted browser.
const main = {
  auth: { getSession, mfa: { listFactors: vi.fn(), challengeAndVerify: vi.fn() } },
};
vi.mock("./supabase-browser", () => ({
  getSupabaseBrowserClient: () => main,
  getMemoryOnlySupabaseClient: (purpose: string) => {
    if (purpose !== "reauthentication") throw new Error(`unexpected purpose ${purpose}`);
    return client;
  },
}));

const input = { email: "ada@example.test", password: "pw", code: null, captchaOptions: {} };
const authorize = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  client.auth.signInWithPassword.mockResolvedValue({ error: null });
  client.auth.signOut.mockResolvedValue({ error: null });
  for (const mfa of [main.auth.mfa, client.auth.mfa]) {
    mfa.listFactors.mockResolvedValue({
      data: { totp: [{ id: "factor-1", status: "verified" }] },
      error: null,
    });
    mfa.challengeAndVerify.mockResolvedValue({ error: null });
  }
  authorize.mockResolvedValue({ error: null });
  getSession.mockResolvedValue({
    data: { session: { access_token: tokenFor("main-session", "aal2") } },
  });
});

function tokenFor(sessionId: string, aal: "aal1" | "aal2"): string {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionId, aal })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("reauthenticate", () => {
  it("signs in, asks for the permission and signs the extra session out", async () => {
    expect(await reauthenticate(input, authorize)).toBeNull();
    expect(main.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(client, "main-session");
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("asks for nothing when the browser itself is not signed in", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    expect(await reauthenticate(input, authorize)).toEqual({ step: "authorize", error: null });
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("stops at a wrong password, before any permission", async () => {
    const error = new AuthApiError("Invalid login credentials", 400, "invalid_credentials");
    client.auth.signInWithPassword.mockResolvedValue({ error });
    expect(await reauthenticate(input, authorize)).toEqual({ step: "password", error });
    expect(authorize).not.toHaveBeenCalled();
  });

  // Supabase Auth ends every aal1 session of the account when a code is verified: the code goes to
  // the extra session after the password, never to the aal2 browser session, which would end it.
  it("verifies the code on the extra session, after the password and before the permission", async () => {
    expect(await reauthenticate({ ...input, code: "123456" }, authorize)).toBeNull();
    expect(main.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: "factor-1",
      code: "123456",
    });
    const verified = client.auth.mfa.challengeAndVerify.mock.invocationCallOrder[0] ?? 0;
    expect(client.auth.signInWithPassword.mock.invocationCallOrder[0]).toBeLessThan(verified);
    expect(verified).toBeLessThan(authorize.mock.invocationCallOrder[0] ?? 0);
  });

  it("on a trusted browser (aal1), verifies the code on its own session before the extra one exists", async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: tokenFor("main-session", "aal1") } },
    });
    expect(await reauthenticate({ ...input, code: "123456" }, authorize)).toBeNull();
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(main.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: "factor-1",
      code: "123456",
    });
    expect(main.auth.mfa.challengeAndVerify.mock.invocationCallOrder[0]).toBeLessThan(
      client.auth.signInWithPassword.mock.invocationCallOrder[0] ?? 0,
    );
    expect(authorize).toHaveBeenCalledWith(client, "main-session");
  });

  it("on a trusted browser, a wrong code stops before any password sign-in", async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: tokenFor("main-session", "aal1") } },
    });
    const error = new AuthApiError("Invalid TOTP code", 422, "mfa_verification_failed");
    main.auth.mfa.challengeAndVerify.mockResolvedValue({ error });
    expect(await reauthenticate({ ...input, code: "000000" }, authorize)).toEqual({
      step: "code",
      error,
    });
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("a wrong password stops before the code is used", async () => {
    const error = new AuthApiError("Invalid login credentials", 400, "invalid_credentials");
    client.auth.signInWithPassword.mockResolvedValue({ error });
    expect(await reauthenticate({ ...input, code: "123456" }, authorize)).toEqual({
      step: "password",
      error,
    });
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
  });

  it("reports a wrong code, asks for nothing and still signs out", async () => {
    const error = new AuthApiError("Invalid TOTP code", 422, "mfa_verification_failed");
    client.auth.mfa.challengeAndVerify.mockResolvedValue({ error });
    expect(await reauthenticate({ ...input, code: "000000" }, authorize)).toEqual({
      step: "code",
      error,
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("reports a missing authenticator as a code failure", async () => {
    client.auth.mfa.listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    expect(await reauthenticate({ ...input, code: "123456" }, authorize)).toEqual({
      step: "code",
      error: null,
    });
  });

  it("reports a refused permission and signs out even if it throws", async () => {
    authorize.mockResolvedValue({ error: { code: "42501" } });
    expect(await reauthenticate(input, authorize)).toEqual({
      step: "authorize",
      error: { code: "42501" },
    });
    authorize.mockRejectedValue(new TypeError("Failed to fetch"));
    client.auth.signOut.mockClear();
    await expect(reauthenticate(input, authorize)).rejects.toThrow("Failed to fetch");
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
  });
});
