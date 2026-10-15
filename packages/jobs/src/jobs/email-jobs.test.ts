import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";
import { runJob } from "../executor.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import type { FakeMail } from "../testing/fake-services.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { invitationEmail } from "./invitation-email.ts";
import { notificationEmail } from "./notification-email.ts";
import { recoveryReady } from "./recovery-ready.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const NOTIFICATION = "3f1b6c52-0a3e-4d9b-8f55-0d9c1b7a2e11";
const INVITATION = "7a0e9d44-1c2b-4f6a-9b3d-5e8f7a6b4c21";
const RECOVERY = "c2d8e5f1-4a6b-4c7d-8e9f-0a1b2c3d4e5f";

function setup() {
  const store = new FakeJobStore();
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    env: "test",
    sink: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { store, lines, logger, services: fakeServices() };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

const readyNotification = {
  outcome: "ok",
  to: "carol@example.test",
  locale: "en",
  kind: "recovery.claimant_paused",
  homeId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001",
  homeName: "De Boomgaard",
  homeTimeZone: "Europe/Brussels",
  params: { recoveryId: RECOVERY },
} as const;

describe("notification-email", () => {
  const key = `notification-email:${NOTIFICATION}`;
  const run = (ctx: ReturnType<typeof setup>) =>
    runJob(notificationEmail, envelope({ notificationId: NOTIFICATION }, key), ctx);

  it("sends the email with the job's idempotency key and records it as sent", async () => {
    const ctx = setup();
    ctx.services.data.notification = readyNotification;
    await run(ctx);
    expect(ctx.services.mail?.delivered).toHaveLength(1);
    const [sent] = ctx.services.mail?.delivered ?? [];
    expect(sent?.idempotencyKey).toBe(key);
    expect(sent?.to).toBe("carol@example.test");
    expect(sent?.subject).toContain("paused");
    expect(sent?.text).toContain(
      `https://app.madeora.test/homes/${readyNotification.homeId}/recovery`,
    );
    expect(ctx.services.data.notificationRecords).toEqual([
      { id: NOTIFICATION, status: "sent", code: null },
    ]);
  });

  it("never sends the same email twice, however often the job runs", async () => {
    const ctx = setup();
    ctx.services.data.notification = readyNotification;
    await run(ctx);
    const second = await run(ctx);
    expect(second).toEqual({ status: "skipped", reason: "already_succeeded" });
    expect(ctx.services.mail?.requests).toHaveLength(1);
  });

  it("passes the same idempotency key on a retry after the provider failed, so a lost answer cannot send twice", async () => {
    const ctx = setup();
    ctx.services.data.notification = readyNotification;
    // The provider accepts the email but the answer is lost: from here it looks unavailable.
    (ctx.services.mail as FakeMail).results = [{ ok: false, reason: "unavailable", status: 503 }];
    await expect(run(ctx)).rejects.toBeInstanceOf(RetryableJobError);
    expect(ctx.services.data.notificationRecords.at(-1)).toEqual({
      id: NOTIFICATION,
      status: "failed",
      code: "email_unavailable",
    });
    await run(ctx);
    const keys = (ctx.services.mail as FakeMail).requests.map((request) => request.idempotencyKey);
    expect(keys).toEqual([key, key]);
    expect(ctx.services.mail?.delivered).toHaveLength(1);
    expect(ctx.services.data.notificationRecords.at(-1)?.status).toBe("sent");
  });

  it("records a refusal and does not retry it", async () => {
    const ctx = setup();
    ctx.services.data.notification = readyNotification;
    (ctx.services.mail as FakeMail).results = [{ ok: false, reason: "rejected", status: 422 }];
    await expect(run(ctx)).rejects.toBeInstanceOf(PermanentJobError);
    expect(ctx.services.data.notificationRecords).toEqual([
      { id: NOTIFICATION, status: "failed", code: "email_rejected" },
    ]);
  });

  it.each(["disabled", "not_member", "no_address", "cannot_receive"] as const)(
    "skips and records it when the database says %s",
    async (outcome) => {
      const ctx = setup();
      ctx.services.data.notification = { outcome };
      await run(ctx);
      expect(ctx.services.mail?.requests).toHaveLength(0);
      expect(ctx.services.data.notificationRecords).toEqual([
        { id: NOTIFICATION, status: "skipped", code: null },
      ]);
    },
  );

  it("does nothing when the email was already recorded", async () => {
    const ctx = setup();
    ctx.services.data.notification = { outcome: "already_done" };
    await run(ctx);
    expect(ctx.services.mail?.requests).toHaveLength(0);
    expect(ctx.services.data.notificationRecords).toEqual([]);
  });

  it("fails permanently for a notification that does not exist", async () => {
    const ctx = setup();
    await expect(run(ctx)).rejects.toMatchObject({ code: "notification_not_found" });
  });

  it("records not_configured and succeeds when the environment sends no email", async () => {
    const ctx = setup();
    const services = fakeServices({ mail: null, appUrl: null });
    services.data.notification = readyNotification;
    const result = await runJob(
      notificationEmail,
      envelope({ notificationId: NOTIFICATION }, key),
      {
        ...ctx,
        services,
      },
    );
    expect(result.status).toBe("succeeded");
    expect(services.data.notificationRecords).toEqual([
      { id: NOTIFICATION, status: "not_configured", code: null },
    ]);
  });

  it("fails permanently, recorded, for a kind with no email template", async () => {
    const ctx = setup();
    ctx.services.data.notification = { ...readyNotification, kind: "recovery.member_requested" };
    await expect(run(ctx)).rejects.toMatchObject({ code: "no_email_template" });
    expect(ctx.services.data.notificationRecords).toEqual([
      { id: NOTIFICATION, status: "failed", code: "no_email_template" },
    ]);
    expect(ctx.services.mail?.requests).toHaveLength(0);
  });

  it("retries when the database cannot be reached, before anything is sent", async () => {
    const ctx = setup();
    ctx.services.data.unavailable = true;
    await expect(run(ctx)).rejects.toBeInstanceOf(RetryableJobError);
    expect(ctx.services.mail?.requests).toHaveLength(0);
  });

  it("refuses a payload with anything but the notification id", async () => {
    const ctx = setup();
    await expect(
      runJob(
        notificationEmail,
        envelope({ notificationId: NOTIFICATION, email: "carol@example.test" }, key),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("logs the outcome and kind but never the address, the Home or the link", async () => {
    const ctx = setup();
    ctx.services.data.notification = readyNotification;
    await run(ctx);
    const logged = JSON.stringify(ctx.lines);
    expect(logged).toContain("jobs.notification_email.sent");
    expect(logged).toContain(CORRELATION);
    expect(logged).not.toContain("carol@example.test");
    expect(logged).not.toContain("De Boomgaard");
    expect(logged).not.toContain("app.madeora.test");
  });
});

describe("invitation-email", () => {
  const key = `invitation-email:${INVITATION}:1`;
  const data = { invitationId: INVITATION, send: 1 };
  const read = {
    outcome: "ok",
    to: "zed@example.test",
    locale: "nl",
    role: "member",
    token: "T".repeat(43),
    expiresAt: new Date("2026-10-22T10:00:00Z"),
    homeName: "Thuis",
    homeTimeZone: "Europe/Brussels",
  } as const;

  it("sends the invitation with the link built from the current secret, keyed by the job", async () => {
    const ctx = setup();
    ctx.services.data.invitation = read;
    await runJob(invitationEmail, envelope(data, key), ctx);
    const [sent] = ctx.services.mail?.delivered ?? [];
    expect(sent?.idempotencyKey).toBe(key);
    expect(sent?.to).toBe("zed@example.test");
    expect(sent?.text).toContain(`https://app.madeora.test/join/${"T".repeat(43)}`);
    expect(ctx.services.data.invitationRecords).toEqual([
      { id: INVITATION, send: 1, status: "sent" },
    ]);
  });

  it.each(["superseded", "not_active", "not_found"] as const)(
    "sends nothing for %s",
    async (outcome) => {
      const ctx = setup();
      ctx.services.data.invitation = { outcome };
      const result = await runJob(invitationEmail, envelope(data, key), ctx);
      expect(result.status).toBe("succeeded");
      expect(ctx.services.mail?.requests).toHaveLength(0);
      expect(ctx.services.data.invitationRecords).toEqual([]);
    },
  );

  it("keeps the status pending during retries, then records sent, with the same key every time", async () => {
    const ctx = setup();
    ctx.services.data.invitation = read;
    (ctx.services.mail as FakeMail).results = [{ ok: false, reason: "unavailable" }];
    await expect(runJob(invitationEmail, envelope(data, key), ctx)).rejects.toBeInstanceOf(
      RetryableJobError,
    );
    expect(ctx.services.data.invitationRecords).toEqual([]);
    await runJob(invitationEmail, envelope(data, key), ctx);
    expect(ctx.services.data.invitationRecords.map((record) => record.status)).toEqual(["sent"]);
    const keys = (ctx.services.mail as FakeMail).requests.map((request) => request.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([key]));
    expect(ctx.services.mail?.delivered).toHaveLength(1);
  });

  it("records failed once the retries are used up", async () => {
    const ctx = setup();
    ctx.services.data.invitation = read;
    const mail = ctx.services.mail as FakeMail;
    for (let attempt = 1; attempt <= invitationEmail.retry.maxAttempts; attempt += 1) {
      mail.results = [{ ok: false, reason: "unavailable" }];
      await expect(runJob(invitationEmail, envelope(data, key), ctx)).rejects.toBeInstanceOf(
        RetryableJobError,
      );
    }
    expect(ctx.services.data.invitationRecords).toEqual([
      { id: INVITATION, send: 1, status: "failed" },
    ]);
  });

  it("records failed and stops when the provider refuses the address", async () => {
    const ctx = setup();
    ctx.services.data.invitation = read;
    (ctx.services.mail as FakeMail).results = [{ ok: false, reason: "rejected", status: 422 }];
    await expect(runJob(invitationEmail, envelope(data, key), ctx)).rejects.toBeInstanceOf(
      PermanentJobError,
    );
    expect(ctx.services.data.invitationRecords).toEqual([
      { id: INVITATION, send: 1, status: "failed" },
    ]);
  });

  it("records not_configured when no email is sent in this environment", async () => {
    const ctx = setup();
    const services = fakeServices({ mail: null, appUrl: null });
    services.data.invitation = read;
    await runJob(invitationEmail, envelope(data, key), { ...ctx, services });
    expect(services.data.invitationRecords).toEqual([
      { id: INVITATION, send: 1, status: "not_configured" },
    ]);
  });

  it("keeps the secret link out of the logs", async () => {
    const ctx = setup();
    ctx.services.data.invitation = read;
    await runJob(invitationEmail, envelope(data, key), ctx);
    const logged = JSON.stringify(ctx.lines);
    expect(logged).not.toContain("T".repeat(43));
    expect(logged).not.toContain("zed@example.test");
  });
});

describe("recovery-ready", () => {
  const data = { recoveryId: RECOVERY, objectionEndsAt: "2026-10-29T16:00:00Z" };

  it("asks the database to notify the person who asked, with the end it was queued for", async () => {
    const ctx = setup();
    ctx.services.data.readyOutcome = "notified";
    await runJob(recoveryReady, envelope(data, `recovery-ready:${RECOVERY}:1`), ctx);
    expect(ctx.services.data.readyCalls).toEqual([
      { recoveryId: RECOVERY, endsAt: new Date("2026-10-29T16:00:00Z") },
    ]);
    expect(ctx.lines.some((line) => line.outcome === "notified")).toBe(true);
  });

  it("succeeds quietly when the case is no longer ready", async () => {
    const ctx = setup();
    const result = await runJob(recoveryReady, envelope(data, `recovery-ready:${RECOVERY}:2`), ctx);
    expect(result.status).toBe("succeeded");
  });

  it("refuses a malformed date", async () => {
    const ctx = setup();
    await expect(
      runJob(recoveryReady, envelope({ ...data, objectionEndsAt: "tomorrow" }, "k"), ctx),
    ).rejects.toMatchObject({ code: "invalid_payload" });
  });
});
