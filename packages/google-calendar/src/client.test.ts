import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GOOGLE_CALENDAR_SCOPES,
  GoogleAuthorizationError,
  GoogleClientError,
  GoogleHttpError,
  createGoogleCalendarClient,
  type FetchLike,
} from "./client.ts";

const config = {
  clientId: "123456-abcdefgh.apps.googleusercontent.com",
  clientSecret: "GOCSPX-secret-value",
  tokenKey: randomBytes(32),
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(answers: ReadonlyArray<Response | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...answers];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error("unexpected request");
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("authorization URL", () => {
  it("asks for the two calendar scopes, offline access, consent, state and PKCE", () => {
    const client = createGoogleCalendarClient(config, fakeFetch([]).fetch);
    const url = new URL(
      client.authorizationUrl({
        redirectUri: "https://app.test/api/v1/integrations/google-calendar/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPES.join(" "));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: config.clientId,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
    expect(url.toString()).not.toContain(config.clientSecret);
  });
});

describe("tokens", () => {
  it("exchanges a code with the verifier and reads the granted scopes", async () => {
    const { fetch, calls } = fakeFetch([
      json(200, {
        access_token: "at",
        refresh_token: "rt",
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      }),
    ]);
    const grant = await createGoogleCalendarClient(config, fetch).exchangeCode({
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://app.test/cb",
    });
    expect(grant).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      scopes: [...GOOGLE_CALENDAR_SCOPES],
    });
    const sent = calls[0]?.init?.body;
    const body = new URLSearchParams(typeof sent === "string" ? sent : "");
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      code: "code",
      code_verifier: "verifier",
      client_secret: config.clientSecret,
    });
  });

  it("tells a refused grant from a refused client and an outage", async () => {
    const answers = [
      json(400, { error: "invalid_grant" }),
      json(401, { error: "invalid_client" }),
      json(503, {}),
      new TypeError("network"),
    ];
    const client = createGoogleCalendarClient(config, fakeFetch(answers).fetch);
    await expect(client.refreshAccessToken("rt")).rejects.toBeInstanceOf(GoogleAuthorizationError);
    await expect(client.refreshAccessToken("rt")).rejects.toBeInstanceOf(GoogleClientError);
    await expect(client.refreshAccessToken("rt")).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
    await expect(client.refreshAccessToken("rt")).rejects.toMatchObject({
      status: 0,
      retryable: true,
    });
  });

  it("revokes, and accepts a token that is already invalid", async () => {
    const client = createGoogleCalendarClient(
      config,
      fakeFetch([json(200, {}), json(400, { error: "invalid_token" })]).fetch,
    );
    await expect(client.revoke("rt")).resolves.toBe(true);
    await expect(client.revoke("rt")).resolves.toBe(false);
  });
});

describe("calendar API", () => {
  it("lists calendars over pages with the access token, dropping what cannot be kept", async () => {
    const { fetch, calls } = fakeFetch([
      json(200, {
        items: [{ id: "a@gmail.com", summary: "A", accessRole: "owner", primary: true }],
        nextPageToken: "p2",
      }),
      json(200, { items: [{ id: "b", summary: "B", accessRole: "nope" }] }),
    ]);
    const calendars = await createGoogleCalendarClient(config, fetch).listCalendars("at");
    expect(calendars.map((c) => c.id)).toEqual(["a@gmail.com"]);
    expect(calls[1]?.url).toContain("pageToken=p2");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer at");
  });

  it("refuses an account with more calendars than Madeora keeps", async () => {
    const items = Array.from({ length: 251 }, (_, n) => ({
      id: `c${String(n)}`,
      summary: "C",
      accessRole: "reader",
    }));
    const { fetch } = fakeFetch([json(200, { items })]);
    await expect(
      createGoogleCalendarClient(config, fetch).listCalendars("at"),
    ).rejects.toMatchObject({
      reason: "too_many_calendars",
    });
  });

  it("lists events incrementally with the sync token only, or a full window without it", async () => {
    const { fetch, calls } = fakeFetch([
      json(200, { items: [{ id: "x", status: "cancelled" }], nextSyncToken: "s2" }),
      json(200, { items: [], nextPageToken: "n" }),
    ]);
    const client = createGoogleCalendarClient(config, fetch);
    const window = {
      timeMin: new Date("2026-11-01T00:00:00Z"),
      timeMax: new Date("2027-11-01T00:00:00Z"),
    };
    const page = await client.listEvents("at", {
      calendarId: "a@gmail.com",
      syncToken: "s1",
      pageToken: null,
      ...window,
    });
    expect(page).toEqual({
      items: [{ id: "x", cancelled: true }],
      nextPageToken: null,
      nextSyncToken: "s2",
    });
    const incremental = new URL(calls[0]?.url ?? "");
    expect(incremental.pathname).toBe("/calendar/v3/calendars/a%40gmail.com/events");
    expect(incremental.searchParams.get("syncToken")).toBe("s1");
    expect(incremental.searchParams.get("singleEvents")).toBe("true");
    expect(incremental.searchParams.has("timeMin")).toBe(false);
    await client.listEvents("at", {
      calendarId: "a@gmail.com",
      syncToken: null,
      pageToken: null,
      ...window,
    });
    const full = new URL(calls[1]?.url ?? "");
    expect(full.searchParams.get("timeMin")).toBe("2026-11-01T00:00:00.000Z");
    expect(full.searchParams.has("syncToken")).toBe(false);
  });

  it("reports 410, rate limits and 401 by kind", async () => {
    const client = createGoogleCalendarClient(
      config,
      fakeFetch([
        json(410, { error: { errors: [{ reason: "fullSyncRequired" }] } }),
        json(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }),
        json(403, { error: { errors: [{ reason: "forbidden" }] } }),
        json(401, {}),
      ]).fetch,
    );
    const request = {
      calendarId: "c",
      syncToken: "s",
      pageToken: null,
      timeMin: new Date(),
      timeMax: new Date(),
    };
    await expect(client.listEvents("at", request)).rejects.toMatchObject({
      status: 410,
      retryable: false,
    });
    await expect(client.listEvents("at", request)).rejects.toMatchObject({
      status: 403,
      retryable: true,
    });
    const forbidden = await client.listEvents("at", request).catch((error: unknown) => error);
    expect(forbidden).toBeInstanceOf(GoogleHttpError);
    expect(forbidden).toMatchObject({ retryable: false });
    await expect(client.listEvents("at", request)).rejects.toBeInstanceOf(GoogleAuthorizationError);
  });

  it("reads the primary calendar's id", async () => {
    const client = createGoogleCalendarClient(
      config,
      fakeFetch([json(200, { id: "alice@gmail.com", accessRole: "owner" })]).fetch,
    );
    await expect(client.primaryCalendarId("at")).resolves.toBe("alice@gmail.com");
  });
});
