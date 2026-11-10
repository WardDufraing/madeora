// S33: the Google Calendar routes. The database decides what is whose (tests/db/rls/google-calendar.test.sql);
// these tests check the OAuth flow (state, person, consent, scopes, refresh token), that the refresh
// token is only ever stored sealed, and how each route answers.
import { GOOGLE_CALENDAR_SCOPES, openRefreshToken } from "@madeora/google-calendar";
import type { Mock } from "vitest";

import type * as ServerModule from "@/google-calendar/server";

import {
  STATE_COOKIE,
  newConnectAttempt,
  sealConnectAttempt,
  type GoogleCalendarServer,
} from "@/google-calendar/server";

import { PUT as saveCalendar } from "./calendars/[calendarId]/route";
import { GET as callback } from "./callback/route";
import { POST as connect } from "./connect/route";
import { DELETE as disconnect, GET as readConnection } from "./route";
import { POST as syncNow } from "./sync/route";

const USER = "0c0a0000-0000-4000-8000-000000000001";
const OTHER_USER = "0c0a0000-0000-4000-8000-000000000002";
const CALENDAR = "0c0a0000-0000-4000-8000-000000000003";
const HOME = "0c0a0000-0000-4000-8000-000000000004";
const KEY = Buffer.alloc(32, 7);

interface Client {
  authorizationUrl: Mock;
  exchangeCode: Mock;
  revoke: Mock;
  primaryCalendarId: Mock;
}
interface State {
  identity: { userId: string } | null;
  configured: boolean;
  cookies: Map<string, { value: string; options: Record<string, unknown> }>;
  rpc: Mock<(name: string, args?: Record<string, unknown>) => { data: unknown; error: unknown }>;
  client: Client;
}
const state = vi.hoisted((): State => ({
  identity: null,
  configured: true,
  cookies: new Map(),
  rpc: vi.fn(),
  client: {
    authorizationUrl: vi.fn(),
    exchangeCode: vi.fn(),
    revoke: vi.fn(),
    primaryCalendarId: vi.fn(),
  },
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const entry = state.cookies.get(name);
        return entry ? { name, value: entry.value } : undefined;
      },
      set: (name: string, value: string, options: Record<string, unknown>) => {
        state.cookies.set(name, { value, options });
      },
    }),
}));
vi.mock("@/google-calendar/server", async (importOriginal) => {
  const actual = await importOriginal<typeof ServerModule>();
  return {
    ...actual,
    getGoogleCalendarServer: (): GoogleCalendarServer | null =>
      state.configured
        ? ({
            client: state.client,
            tokenKey: KEY,
            redirectUri: "https://madeora.example/api/v1/integrations/google-calendar/callback",
          } as unknown as GoogleCalendarServer)
        : null,
  };
});

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const crossSite = { origin: "https://evil.example", host: "madeora.example" };

function jsonRequest(path: string, method: string, body: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1/integrations/google-calendar${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function formPost(headers = sameOrigin): Request {
  return new Request("https://madeora.example/api/v1/integrations/google-calendar/connect", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: "",
  });
}

/** A connect attempt started by `userId`, kept in the cookie, and Google's return to the callback. */
function startAttempt(userId = USER, at = new Date()) {
  const attempt = newConnectAttempt(userId, at);
  state.cookies.set(STATE_COOKIE, { value: sealConnectAttempt(attempt, KEY), options: {} });
  return attempt.state;
}
function back(params: Record<string, string>): Request {
  const url = new URL("https://madeora.example/api/v1/integrations/google-calendar/callback");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return new Request(url);
}
const grantedScopes = [...GOOGLE_CALENDAR_SCOPES];

function notice(response: Response): string | null {
  const location = response.headers.get("Location") ?? "";
  return new URL(location, "https://madeora.example").searchParams.get("google");
}

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

beforeEach(() => {
  state.identity = { userId: USER };
  state.configured = true;
  state.cookies.clear();
  state.rpc.mockReset();
  state.client.authorizationUrl
    .mockReset()
    .mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  state.client.exchangeCode.mockReset().mockResolvedValue({
    accessToken: "access-1",
    refreshToken: "refresh-1",
    scopes: grantedScopes,
  });
  state.client.revoke.mockReset().mockResolvedValue(true);
  state.client.primaryCalendarId.mockReset().mockResolvedValue("person@example.com");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("connect", () => {
  it("refuses a cross-site form", async () => {
    expect((await connect(formPost(crossSite))).status).toBe(403);
    expect(state.cookies.size).toBe(0);
  });

  it("sends a signed-out person to sign in, and says when Google Calendar is not configured", async () => {
    state.identity = null;
    const signedOut = await connect(formPost());
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("Location")).toContain("google-calendar");
    state.identity = { userId: USER };
    state.configured = false;
    expect(notice(await connect(formPost()))).toBe("unavailable");
  });

  it("keeps a sealed, httpOnly state cookie for the callback and sends the browser to Google with PKCE", async () => {
    const response = await connect(formPost());
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookie = state.cookies.get(STATE_COOKIE);
    expect(cookie?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/v1/integrations/google-calendar/callback",
      maxAge: 600,
    });
    const [{ state: sentState, codeChallenge }] = state.client.authorizationUrl.mock.calls[0] as [
      { state: string; codeChallenge: string },
    ];
    // The cookie holds neither the state nor the verifier in readable form.
    expect(cookie?.value).not.toContain(sentState);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("callback", () => {
  it("refuses a return without this browser's attempt, with another state, or for another person", async () => {
    expect(notice(await callback(back({ state: "x".repeat(43), code: "c" })))).toBe("state");
    startAttempt();
    expect(notice(await callback(back({ state: "y".repeat(43), code: "c" })))).toBe("state");
    const forOther = startAttempt(OTHER_USER);
    expect(notice(await callback(back({ state: forOther, code: "c" })))).toBe("state");
    expect(state.client.exchangeCode).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses an expired attempt and uses the cookie only once", async () => {
    const old = startAttempt(USER, new Date(Date.now() - 11 * 60 * 1000));
    expect(notice(await callback(back({ state: old, code: "c" })))).toBe("state");
    const fresh = startAttempt();
    answers({ save_google_calendar_connection: "connected" });
    expect(notice(await callback(back({ state: fresh, code: "c" })))).toBe("connected");
    expect(state.cookies.get(STATE_COOKIE)?.value).toBe("");
    expect(notice(await callback(back({ state: fresh, code: "c" })))).toBe("state");
  });

  it("refuses a signed-out return", async () => {
    const value = startAttempt();
    state.identity = null;
    expect(notice(await callback(back({ state: value, code: "c" })))).toBe("state");
  });

  it("says cancelled when the person declined at Google", async () => {
    const value = startAttempt();
    expect(notice(await callback(back({ state: value, error: "access_denied" })))).toBe(
      "cancelled",
    );
    expect(state.client.exchangeCode).not.toHaveBeenCalled();
  });

  it("revokes and stores nothing when a calendar scope was not granted", async () => {
    const value = startAttempt();
    state.client.exchangeCode.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      scopes: [GOOGLE_CALENDAR_SCOPES[0]],
    });
    expect(notice(await callback(back({ state: value, code: "c" })))).toBe("missing_scope");
    expect(state.client.revoke).toHaveBeenCalledWith("refresh-1");
    // Nothing stored; only the failed attempt is recorded in the person's activity (S38).
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["record_integration_failure"]);
  });

  it("revokes and stores nothing without a refresh token", async () => {
    const value = startAttempt();
    state.client.exchangeCode.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: null,
      scopes: grantedScopes,
    });
    expect(notice(await callback(back({ state: value, code: "c" })))).toBe("failed");
    expect(state.client.revoke).toHaveBeenCalledWith("access-1");
    // Nothing stored; only the failed attempt is recorded in the person's activity (S38).
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["record_integration_failure"]);
  });

  it("says failed when Google refuses the code", async () => {
    const value = startAttempt();
    state.client.exchangeCode.mockRejectedValue(new Error("invalid_grant"));
    expect(notice(await callback(back({ state: value, code: "c" })))).toBe("failed");
    // Nothing stored; only the failed attempt is recorded in the person's activity (S38).
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["record_integration_failure"]);
  });

  it("stores the refresh token sealed for this person only, with the PKCE verifier", async () => {
    const value = startAttempt();
    answers({ save_google_calendar_connection: "replaced" });
    expect(notice(await callback(back({ state: value, code: "the-code" })))).toBe("replaced");
    const [{ codeVerifier, code }] = state.client.exchangeCode.mock.calls[0] as [
      { codeVerifier: string; code: string },
    ];
    expect(code).toBe("the-code");
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    const [name, args] = state.rpc.mock.calls[0] ?? [];
    expect(name).toBe("save_google_calendar_connection");
    const sealed = String(args?.p_token);
    expect(sealed).not.toContain("refresh-1");
    expect(openRefreshToken(sealed, KEY, USER)).toBe("refresh-1");
    expect(() => openRefreshToken(sealed, KEY, OTHER_USER)).toThrow();
    expect(args?.p_account).toBe("person@example.com");
    expect(state.client.revoke).not.toHaveBeenCalled();
  });

  it("revokes the grant when the database does not keep it", async () => {
    const value = startAttempt();
    state.rpc.mockReturnValue({ data: null, error: { code: "42501" } });
    expect(notice(await callback(back({ state: value, code: "c" })))).toBe("failed");
    expect(state.client.revoke).toHaveBeenCalledWith("refresh-1");
  });
});

describe("the connection", () => {
  it("answers the person's own connection, never for a signed-out person", async () => {
    answers({ get_google_calendar_connection: null });
    const response = await readConnection();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection: null });
    state.identity = null;
    expect((await readConnection()).status).toBe(401);
  });

  it("disconnects and revokes the stored token at Google", async () => {
    const { sealRefreshToken } = await import("@madeora/google-calendar");
    answers({ disconnect_google_calendar: sealRefreshToken("refresh-1", KEY, USER) });
    const response = await disconnect(jsonRequest("", "DELETE", {}));
    expect(await response.json()).toEqual({ outcome: "disconnected", revoked: true });
    expect(state.client.revoke).toHaveBeenCalledWith("refresh-1");
  });

  it("still disconnects when Google cannot be reached, and says it was not revoked", async () => {
    const { sealRefreshToken } = await import("@madeora/google-calendar");
    answers({ disconnect_google_calendar: sealRefreshToken("refresh-1", KEY, USER) });
    state.client.revoke.mockRejectedValue(new Error("network"));
    const response = await disconnect(jsonRequest("", "DELETE", {}));
    expect(await response.json()).toEqual({ outcome: "disconnected", revoked: false });
  });

  it("answers not connected, and refuses cross-site and signed-out requests", async () => {
    answers({ disconnect_google_calendar: null });
    expect(await (await disconnect(jsonRequest("", "DELETE", {}))).json()).toEqual({
      outcome: "not_connected",
    });
    expect((await disconnect(jsonRequest("", "DELETE", {}, crossSite))).status).toBe(403);
    state.identity = null;
    expect((await disconnect(jsonRequest("", "DELETE", {}))).status).toBe(401);
  });
});

describe("sync now", () => {
  it.each([
    ["queued", 200],
    ["too_soon", 429],
    ["not_connected", 404],
    ["authorization_expired", 409],
  ])("answers %s with %i", async (outcome, status) => {
    answers({ request_google_calendar_sync: outcome });
    expect((await syncNow(jsonRequest("/sync", "POST", {}))).status).toBe(status);
  });

  it("takes no input", async () => {
    expect((await syncNow(jsonRequest("/sync", "POST", { force: true }))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("calendar choices", () => {
  const params = { params: Promise.resolve({ calendarId: CALENDAR }) };

  it("sends the choices to the database and maps its answers", async () => {
    answers({ set_google_calendar_settings: "saved" });
    const body = { sync: true, showPersonal: true, homes: [HOME] };
    expect(
      (await saveCalendar(jsonRequest(`/calendars/${CALENDAR}`, "PUT", body), params)).status,
    ).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_google_calendar_settings", {
      p_calendar_id: CALENDAR,
      p_sync: true,
      p_show_personal: true,
      p_home_ids: [HOME],
    });
    for (const [outcome, status] of [
      ["not_found", 404],
      ["unavailable", 409],
      ["invalid_home", 400],
      ["too_many", 409],
    ] as const) {
      answers({ set_google_calendar_settings: outcome });
      const response = await saveCalendar(jsonRequest(`/calendars/${CALENDAR}`, "PUT", body), {
        params: Promise.resolve({ calendarId: CALENDAR }),
      });
      expect(response.status, outcome).toBe(status);
    }
  });

  it("refuses a calendar that does not sync but shows somewhere, and a malformed id", async () => {
    const shows = { sync: false, showPersonal: true, homes: [] };
    expect(
      (await saveCalendar(jsonRequest(`/calendars/${CALENDAR}`, "PUT", shows), params)).status,
    ).toBe(400);
    const body = { sync: true, showPersonal: false, homes: [] };
    const bad = { params: Promise.resolve({ calendarId: "not-an-id" }) };
    expect((await saveCalendar(jsonRequest("/calendars/not-an-id", "PUT", body), bad)).status).toBe(
      404,
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
