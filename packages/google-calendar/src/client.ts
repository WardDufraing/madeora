/**
 * Google's OAuth and Calendar endpoints (S33), with fetch injected so every rule is unit-tested without
 * Google. Server-only: it holds the client secret. Access tokens live in memory for one operation and are
 * never stored or logged; errors carry codes only, never a response body.
 *
 * Scopes (architecture.md §31, the narrowest pair that reads the calendar list and reads and writes
 * events): `calendar.calendarlist.readonly` and `calendar.events`. Writes (S34) use Google's etags
 * (If-Match), so a change never overwrites a newer Google version.
 */
import { z } from "zod";

import type { GoogleCalendarConfig } from "./config.ts";
import {
  normalizeCalendar,
  normalizeEvent,
  type NormalizedCalendar,
  type NormalizedEvent,
} from "./normalize.ts";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API_URL = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = 15_000;

/** Google refused the grant (consent revoked, testing-mode token expired, code reused). */
export class GoogleAuthorizationError extends Error {
  constructor(readonly code: "invalid_grant" | "unauthorized") {
    super(`google authorization refused: ${code}`);
    this.name = "GoogleAuthorizationError";
  }
}

/** Google refused the client itself (wrong id or secret): a configuration problem. */
export class GoogleClientError extends Error {
  constructor(readonly code: "invalid_client" | "invalid_request") {
    super(`google client refused: ${code}`);
    this.name = "GoogleClientError";
  }
}

/** An HTTP answer other than success; `status` 0 when Google could not be reached. */
export class GoogleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(`google request failed: ${String(status)}${reason ? ` ${reason}` : ""}`);
    this.name = "GoogleHttpError";
  }

  /** Worth retrying later: unreachable, rate limited or a server error. */
  get retryable(): boolean {
    return (
      this.status === 0 ||
      this.status === 429 ||
      this.status >= 500 ||
      (this.status === 403 &&
        (this.reason === "rateLimitExceeded" || this.reason === "userRateLimitExceeded"))
    );
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TokenGrant {
  readonly refreshToken: string | null;
  readonly accessToken: string;
  readonly scopes: readonly string[];
}

export interface EventPage {
  readonly items: readonly NormalizedEvent[];
  readonly nextPageToken: string | null;
  readonly nextSyncToken: string | null;
}

export interface EventPageRequest {
  readonly calendarId: string;
  /** Incremental: the stored sync token. Null: a full pass over the window. */
  readonly syncToken: string | null;
  readonly pageToken: string | null;
  /** The full pass's window (ignored with a sync token, as Google requires). */
  readonly timeMin: Date;
  readonly timeMax: Date;
}

/** The parts of a Google event resource that writing needs (master events carry `recurrence`). */
export interface GoogleEventResource {
  readonly id: string;
  readonly etag: string | null;
  readonly status: string | null;
  readonly summary: string | null;
  readonly location: string | null;
  readonly description: string | null;
  readonly visibility: string | null;
  readonly transparency: string | null;
  readonly colorId: string | null;
  readonly start: GoogleWhen | null;
  readonly end: GoogleWhen | null;
  readonly recurrence: readonly string[];
}

export interface GoogleWhen {
  readonly date?: string | undefined;
  readonly dateTime?: string | undefined;
  readonly timeZone?: string | undefined;
}

/** A body for insert or patch (Google's event resource, only what Madeora writes). */
export interface GoogleEventBody {
  readonly id?: string;
  readonly status?: "confirmed";
  readonly summary?: string;
  readonly location?: string;
  readonly description?: string;
  readonly visibility?: string;
  readonly transparency?: string;
  readonly colorId?: string;
  readonly start?: GoogleWhen;
  readonly end?: GoogleWhen;
  readonly recurrence?: readonly string[];
}

export interface WrittenEvent {
  /** Null when Google answered with an event Madeora cannot store (it is then read again by the sync). */
  readonly event: NormalizedEvent | null;
  readonly resource: GoogleEventResource;
}

export interface GoogleCalendarClient {
  authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<TokenGrant>;
  refreshAccessToken(refreshToken: string): Promise<string>;
  /** True when Google confirmed; false when it answered the token was already invalid. */
  revoke(token: string): Promise<boolean>;
  primaryCalendarId(accessToken: string): Promise<string>;
  listCalendars(accessToken: string): Promise<readonly NormalizedCalendar[]>;
  listEvents(accessToken: string, request: EventPageRequest): Promise<EventPage>;
  /** Null when Google answers 404 or 410 (gone). A cancelled event comes back with status "cancelled". */
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<WrittenEvent | null>;
  /** 409: an event with that id exists already (GoogleHttpError). */
  insertEvent(
    accessToken: string,
    calendarId: string,
    body: GoogleEventBody,
  ): Promise<WrittenEvent>;
  /** `etag` makes it conditional (If-Match): 412 when Google has a newer version. */
  patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    body: GoogleEventBody,
    etag: string | null,
  ): Promise<WrittenEvent>;
  deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    etag: string | null,
  ): Promise<void>;
}

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
const oauthError = z.object({ error: z.string() });
const when = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});
const resource = z.object({
  id: z.string().min(1).max(1024),
  etag: z.string().max(200).optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  visibility: z.string().optional(),
  transparency: z.string().optional(),
  colorId: z.string().optional(),
  start: when.optional(),
  end: when.optional(),
  recurrence: z.array(z.string().max(2048)).max(50).optional(),
});

function written(json: unknown, status: number): WrittenEvent {
  const parsed = resource.safeParse(json);
  if (!parsed.success) throw new GoogleHttpError(status, "bad_answer");
  const raw = parsed.data;
  return {
    event: normalizeEvent(json),
    resource: {
      id: raw.id,
      etag: raw.etag ?? null,
      status: raw.status ?? null,
      summary: raw.summary ?? null,
      location: raw.location ?? null,
      description: raw.description ?? null,
      visibility: raw.visibility ?? null,
      transparency: raw.transparency ?? null,
      colorId: raw.colorId ?? null,
      start: raw.start ?? null,
      end: raw.end ?? null,
      recurrence: raw.recurrence ?? [],
    },
  };
}

const apiError = z.object({
  error: z.object({ errors: z.array(z.object({ reason: z.string() })).optional() }).optional(),
});

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Never let more than 8 pages of calendar list through. */
const MAX_LIST_PAGES = 8;
/** The most calendars one account may list (the database's `listed_calendars` limit). */
export const MAX_LISTED_CALENDARS = 250;

export function createGoogleCalendarClient(
  config: GoogleCalendarConfig,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): GoogleCalendarClient {
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new GoogleHttpError(0, null);
    }
  }

  async function tokenRequest(body: Record<string, string>): Promise<z.output<typeof tokenAnswer>> {
    const response = await send(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...body,
      }).toString(),
    });
    const json = await readJson(response);
    if (response.ok) {
      const parsed = tokenAnswer.safeParse(json);
      if (!parsed.success) throw new GoogleHttpError(response.status, "bad_answer");
      return parsed.data;
    }
    const error = oauthError.safeParse(json);
    const code = error.success ? error.data.error : null;
    if (code === "invalid_grant") throw new GoogleAuthorizationError("invalid_grant");
    if (code === "invalid_client" || code === "unauthorized_client") {
      throw new GoogleClientError("invalid_client");
    }
    if (response.status >= 400 && response.status < 500)
      throw new GoogleClientError("invalid_request");
    throw new GoogleHttpError(response.status, null);
  }

  async function api(
    accessToken: string,
    path: string,
    query: URLSearchParams | null,
    write: {
      readonly method: "POST" | "PATCH" | "DELETE";
      readonly body?: unknown;
      readonly etag?: string | null;
    } | null = null,
  ): Promise<unknown> {
    const url = `${API_URL}${path}${query ? `?${query.toString()}` : ""}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    if (write?.body !== undefined) headers["Content-Type"] = "application/json";
    if (write?.etag) headers["If-Match"] = write.etag;
    const response = await send(url, {
      method: write?.method ?? "GET",
      headers,
      ...(write?.body !== undefined ? { body: JSON.stringify(write.body) } : {}),
    });
    if (response.ok && response.status === 204) return null;
    const json = await readJson(response);
    if (response.ok) return json;
    if (response.status === 401) throw new GoogleAuthorizationError("unauthorized");
    const parsed = apiError.safeParse(json);
    throw new GoogleHttpError(
      response.status,
      parsed.success ? (parsed.data.error?.errors?.[0]?.reason ?? null) : null,
    );
  }

  return {
    authorizationUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
        access_type: "offline",
        // Always ask, so Google always returns a refresh token (and the person sees what they grant).
        prompt: "consent",
        include_granted_scopes: "false",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const answer = await tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      });
      return {
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token ?? null,
        scopes: (answer.scope ?? "").split(" ").filter((scope) => scope.length > 0),
      };
    },

    async refreshAccessToken(refreshToken) {
      const answer = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      return answer.access_token;
    },

    async revoke(token) {
      const response = await send(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
      if (response.ok) return true;
      // Google answers 400 invalid_token for a token that is already revoked or expired.
      if (response.status === 400) return false;
      throw new GoogleHttpError(response.status, null);
    },

    async primaryCalendarId(accessToken) {
      const json = await api(accessToken, "/users/me/calendarList/primary", null);
      const parsed = z.object({ id: z.string().min(1).max(320) }).safeParse(json);
      if (!parsed.success) throw new GoogleHttpError(200, "bad_answer");
      return parsed.data.id;
    },

    async listCalendars(accessToken) {
      const calendars: NormalizedCalendar[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({ maxResults: "250" });
        if (pageToken) query.set("pageToken", pageToken);
        const json = await api(accessToken, "/users/me/calendarList", query);
        const parsed = z
          .object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().optional() })
          .safeParse(json);
        if (!parsed.success) throw new GoogleHttpError(200, "bad_answer");
        for (const item of parsed.data.items ?? []) {
          const calendar = normalizeCalendar(item);
          if (calendar) calendars.push(calendar);
        }
        if (calendars.length > MAX_LISTED_CALENDARS) {
          throw new GoogleHttpError(200, "too_many_calendars");
        }
        pageToken = parsed.data.nextPageToken ?? null;
        if (!pageToken) return calendars;
      }
      throw new GoogleHttpError(200, "too_many_calendars");
    },

    async listEvents(accessToken, request) {
      const query = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
      if (request.syncToken) {
        query.set("syncToken", request.syncToken);
      } else {
        query.set("timeMin", request.timeMin.toISOString());
        query.set("timeMax", request.timeMax.toISOString());
      }
      if (request.pageToken) query.set("pageToken", request.pageToken);
      const json = await api(
        accessToken,
        `/calendars/${encodeURIComponent(request.calendarId)}/events`,
        query,
      );
      const parsed = z
        .object({
          items: z.array(z.unknown()).optional(),
          nextPageToken: z.string().optional(),
          nextSyncToken: z.string().max(2048).optional(),
        })
        .safeParse(json);
      if (!parsed.success) throw new GoogleHttpError(200, "bad_answer");
      const items: NormalizedEvent[] = [];
      for (const item of parsed.data.items ?? []) {
        const event = normalizeEvent(item);
        if (event) items.push(event);
      }
      return {
        items,
        nextPageToken: parsed.data.nextPageToken ?? null,
        nextSyncToken: parsed.data.nextSyncToken ?? null,
      };
    },

    async getEvent(accessToken, calendarId, eventId) {
      try {
        const json = await api(accessToken, eventPath(calendarId, eventId), null);
        return written(json, 200);
      } catch (error) {
        if (error instanceof GoogleHttpError && (error.status === 404 || error.status === 410)) {
          return null;
        }
        throw error;
      }
    },

    async insertEvent(accessToken, calendarId, body) {
      const json = await api(
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        null,
        {
          method: "POST",
          body,
        },
      );
      return written(json, 200);
    },

    async patchEvent(accessToken, calendarId, eventId, body, etag) {
      const json = await api(accessToken, eventPath(calendarId, eventId), null, {
        method: "PATCH",
        body,
        etag,
      });
      return written(json, 200);
    },

    async deleteEvent(accessToken, calendarId, eventId, etag) {
      await api(accessToken, eventPath(calendarId, eventId), null, { method: "DELETE", etag });
    },
  };
}

function eventPath(calendarId: string, eventId: string): string {
  return `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}
