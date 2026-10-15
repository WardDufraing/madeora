import { describe, expect, it } from "vitest";

import {
  createLogger,
  isCorrelationId,
  newCorrelationId,
  REDACTED,
  type LogLevel,
} from "./index.ts";

function capture() {
  const lines: { level: LogLevel; entry: Record<string, unknown> }[] = [];
  const logger = createLogger({
    env: "test",
    correlationId: "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f",
    sink: (level, line) => {
      lines.push({ level, entry: JSON.parse(line) as Record<string, unknown> });
    },
    now: () => new Date("2026-10-15T10:00:00.000Z"),
  });
  return { logger, lines };
}

describe("correlation IDs", () => {
  it("generates distinct UUID v4 values that pass validation", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCorrelationId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isCorrelationId(id)).toBe(true);
  });

  it.each([
    "",
    "abc",
    "0B6F3F2E-5D7A-4C1B-9E2F-1A2B3C4D5E6F",
    "0b6f3f2e-5d7a-1c1b-9e2f-1a2b3c4d5e6f",
    '0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f\n{"level":"error"}',
    null,
    42,
  ])("refuses %j", (value) => {
    expect(isCorrelationId(value)).toBe(false);
  });
});

describe("structured logger", () => {
  it("writes one JSON line with the standard fields", () => {
    const { logger, lines } = capture();
    logger.info("jobs.outbox.dispatched", { job: "sample-ping", attempts: 2, ok: true });
    expect(lines).toEqual([
      {
        level: "info",
        entry: {
          ts: "2026-10-15T10:00:00.000Z",
          level: "info",
          event: "jobs.outbox.dispatched",
          env: "test",
          correlationId: "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f",
          job: "sample-ping",
          attempts: 2,
          ok: true,
        },
      },
    ]);
  });

  it("never lets fields overwrite the standard ones", () => {
    const { logger, lines } = capture();
    logger.warn("jobs.test", { level: "debug", correlationId: "forged", ts: "x", env: "prod" });
    expect(lines[0]?.entry).toMatchObject({
      level: "warn",
      env: "test",
      correlationId: "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f",
    });
  });

  it("replaces an invalid event name instead of logging arbitrary text", () => {
    const { logger, lines } = capture();
    logger.error("user alice@example.com failed");
    expect(lines[0]?.entry.event).toBe("log.invalid_event_name");
  });

  it.each([
    ["accessToken", "abc"],
    ["refresh_token", "abc"],
    ["SUPABASE_SERVICE_ROLE_KEY", "abc"],
    ["RESEND_API_KEY", "abc"],
    ["password", "hunter2"],
    ["authorization", "Bearer abc"],
    ["cookie", "sb=abc"],
    ["recipientEmail", "a@b.c"],
    ["signedUrl", "https://r2.example/x"],
    ["body", "<p>hello</p>"],
    ["payload", "{}"],
    ["statement", "my private reasons"],
    ["displayName", "Alice Smith"],
    ["full_name", "Alice Smith"],
    ["homeName", "Thuis"],
  ])("redacts the sensitive field %s", (key, value) => {
    const { logger, lines } = capture();
    logger.info("jobs.test", { [key]: value });
    expect(lines[0]?.entry[key]).toBe(REDACTED);
    expect(JSON.stringify(lines)).not.toContain(value === "{}" ? '"{}"' : value);
  });

  it("masks token-shaped values in innocent-looking fields", () => {
    const { logger, lines } = capture();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl";
    logger.error("jobs.test", {
      detail: `failed with ${jwt}`,
      key1: "re_AbCdEf123456789",
      key2: "tr_prod_AbCdEf123456789",
      key3: "sb_secret_AbCdEf123456789",
      auth: "Bearer abc.def",
      who: "contact bob@example.org now",
      link: "https://madeora.studio/join?token=abcdef#x",
    });
    const text = JSON.stringify(lines);
    for (const secret of [
      jwt,
      "re_AbCdEf123456789",
      "tr_prod_AbCdEf123456789",
      "sb_secret_AbCdEf123456789",
      "abc.def",
      "bob@example.org",
      "token=abcdef",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(lines[0]?.entry.link).toBe("https://madeora.studio/join?[redacted]");
  });

  it("cuts long strings", () => {
    const { logger, lines } = capture();
    logger.info("jobs.test", { detail: "x".repeat(1000) });
    expect(String(lines[0]?.entry.detail).length).toBeLessThanOrEqual(201);
  });

  it("child loggers add fields and may set the correlation ID", () => {
    const { logger, lines } = capture();
    const child = logger.child({ job: "sample-ping", correlationId: "c-2" });
    child.info("jobs.run.started", { attempt: 1 });
    expect(lines[0]?.entry).toMatchObject({
      job: "sample-ping",
      correlationId: "c-2",
      attempt: 1,
    });
  });

  it("routes warnings and errors to the error stream by default", () => {
    const original = { log: console.log, error: console.error };
    const out: string[] = [];
    const err: string[] = [];
    console.log = (line: string) => out.push(line);
    console.error = (line: string) => err.push(line);
    try {
      const logger = createLogger({ env: "test" });
      logger.info("a.b");
      logger.error("c.d");
    } finally {
      console.log = original.log;
      console.error = original.error;
    }
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
  });
});
