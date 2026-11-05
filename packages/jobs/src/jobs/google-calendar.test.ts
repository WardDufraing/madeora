import { randomBytes } from "node:crypto";

import {
  GoogleHttpError,
  sealRefreshToken,
  type GoogleCalendarClient,
} from "@madeora/google-calendar";
import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { googleCalendarSync } from "./google-calendar.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const CONNECTION = "4b1e7c2a-3d5f-4e6a-9b8c-0d1e2f3a4b03";
const USER = "10000000-0000-4000-8000-000000000001";
const key = randomBytes(32);

function google(overrides: Partial<GoogleCalendarClient> = {}): GoogleCalendarClient {
  return {
    authorizationUrl: () => "",
    exchangeCode: () => Promise.reject(new Error("unused")),
    refreshAccessToken: () => Promise.resolve("access"),
    revoke: () => Promise.resolve(true),
    primaryCalendarId: () => Promise.resolve("a@gmail.com"),
    listCalendars: () => Promise.resolve([]),
    listEvents: () => Promise.reject(new Error("unused")),
    ...overrides,
  };
}

function setup(client: GoogleCalendarClient | null) {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  const services = fakeServices({ googleCalendar: client ? { client, tokenKey: key } : null });
  return { store: new FakeJobStore(), logger, lines, services };
}

function envelope(idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data: { connectionId: CONNECTION } };
}

describe("google-calendar-sync", () => {
  it("syncs the connection and logs only the outcome, never the token", async () => {
    const ctx = setup(google());
    ctx.services.data.googleBegin = {
      outcome: "ok",
      userId: USER,
      token: sealRefreshToken("refresh-secret", key, USER),
    };
    await runJob(googleCalendarSync, envelope("google-calendar-sync:1"), ctx);
    expect(ctx.services.data.googleCalls).toEqual([`begin:${CONNECTION}`, "finish:ok"]);
    const log = ctx.lines.join("\n");
    expect(log).toContain("synced");
    expect(log).not.toContain("refresh-secret");
    expect(log).not.toContain(CONNECTION);
  });

  it("does nothing for a removed, expired or busy connection", async () => {
    for (const outcome of ["missing", "expired", "busy", "inactive"] as const) {
      const ctx = setup(google());
      ctx.services.data.googleBegin = { outcome };
      await runJob(googleCalendarSync, envelope(`gcs:${outcome}`), ctx);
      expect(ctx.services.data.googleCalls).toEqual([`begin:${CONNECTION}`]);
    }
  });

  it("is retried when Google cannot be reached", async () => {
    const ctx = setup(
      google({ refreshAccessToken: () => Promise.reject(new GoogleHttpError(0, null)) }),
    );
    ctx.services.data.googleBegin = {
      outcome: "ok",
      userId: USER,
      token: sealRefreshToken("r", key, USER),
    };
    await expect(runJob(googleCalendarSync, envelope("gcs:outage"), ctx)).rejects.toMatchObject({
      code: "google_unavailable",
    });
    expect(ctx.services.data.googleCalls).toContain("finish:google_unavailable");
  });

  it("stops for good where Google Calendar is not configured", async () => {
    const ctx = setup(null);
    await expect(runJob(googleCalendarSync, envelope("gcs:off"), ctx)).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("refuses a payload with anything but a connection id", async () => {
    const ctx = setup(google());
    await expect(
      runJob(
        googleCalendarSync,
        {
          v: 1,
          correlationId: CORRELATION,
          idempotencyKey: "gcs:bad",
          data: { connectionId: CONNECTION, token: "x" },
        },
        ctx,
      ),
    ).rejects.toBeDefined();
  });
});
